import type { PlatformTitleRef } from '../shared/contracts';
import { normaliseTitle } from '../shared/identity';
import { validateFilmCredits, type FilmCredits } from '../shared/edition';
import { Repository, txGet, txPut } from '../background/repository';

export type NetflixMetadataResult =
  | { kind: 'matched'; title: string; mediaType: 'movie'; year: number; checkedAt: number; credits?: FilmCredits }
  | { kind: 'matched'; title: string; mediaType: 'series'; year?: undefined; checkedAt: number; credits?: FilmCredits }
  | { kind: 'missing' }
  | { kind: 'deferred'; reason: 'busy' | 'offline' | 'provider'; message: string; retryAfter?: number };
type CachedMetadata = Exclude<NetflixMetadataResult, { kind: 'deferred' }>;
interface MetadataCache { expiresAt: number; result: CachedMetadata; creditsChecked?: boolean; parserVersion?: number }
interface SourceState { nextAt: number; leaseUntil: number; leaseId?: string; failures: number; cooldownUntil: number; lastClock: number }
interface Job { key: string; titleId: string; demands: Set<() => boolean>; promise: Promise<NetflixMetadataResult>; complete(value: NetflixMetadataResult): void }
const DAY = 86400000;
const MAX_HTML = 2 * 1024 * 1024;
const TRANSPORT = 'netflix-metadata:transport';
const ID = /^\d{1,12}$/;
const cacheKey = (id: string) => JSON.stringify(['netflix-metadata', 'netflix', id]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const deferred = (reason: 'busy' | 'offline' | 'provider', message: string, retryAfter?: number): NetflixMetadataResult =>
  ({ kind: 'deferred', reason, message, ...(retryAfter === undefined ? {} : { retryAfter }) });
class MetadataFailure extends Error {
  constructor(message: string, readonly retryAfter?: number, readonly reason: 'offline' | 'provider' = 'provider') { super(message); }
}

function attribute(source: string, name: string): string | undefined {
  const pattern = /([^\s<>"'=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>"'=]+)))?/g;
  const values: string[] = [];
  for (const match of source.matchAll(pattern)) if (match[1].toLowerCase() === name) values.push(match[2] ?? match[3] ?? match[4] ?? '');
  if (values.length > 1) throw new MetadataFailure('The public title page contained conflicting metadata attributes.');
  return values[0];
}
function decodedText(source: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
  return source.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return entities[code.toLowerCase()] ?? entity;
    const point = Number.parseInt(code.slice(code[1].toLowerCase() === 'x' ? 2 : 1), code[1].toLowerCase() === 'x' ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  }).replace(/\s+/gu, ' ').trim();
}
function netflixUrlId(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.origin !== 'https://www.netflix.com' || url.username || url.password) return undefined;
    return url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/(\d{1,12})\/?$/i)?.[1];
  } catch { return undefined; }
}
function schemaNodes(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4) throw new MetadataFailure('The public title metadata structure was unsupported.');
  if (Array.isArray(value)) {
    if (value.length > 100) throw new MetadataFailure('The public title metadata was too large.');
    return value.flatMap(node => schemaNodes(node, depth + 1));
  }
  if (!object(value)) return [];
  return [value, ...(value['@graph'] === undefined ? [] : schemaNodes(value['@graph'], depth + 1))];
}
function schemaTypes(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((type): type is string => typeof type === 'string')
    .map(type => type.replace(/^https?:\/\/schema\.org\//, ''));
}
function movieCredits(movie: Record<string, unknown>, series = false): FilmCredits | undefined {
  const people = (value: unknown): string[] | undefined => {
    const entries = Array.isArray(value) ? value : [value];
    if (entries.length > 40 || entries.some(entry => !object(entry) || !schemaTypes(entry['@type']).includes('Person') || typeof entry.name !== 'string')) return undefined;
    return entries.map(entry => (entry as Record<string, unknown>).name as string);
  };
  const role = (singular: string, plural: string): string[] | undefined => {
    const fields = [singular, plural].filter(field => Object.hasOwn(movie, field));
    if (!fields.length) return undefined;
    const lists = fields.map(field => people(movie[field]));
    if (lists.some(list => !list)) return undefined;
    const signatures = lists.map(list => JSON.stringify([...new Set(list!.map(normaliseTitle))].sort()));
    return new Set(signatures).size === 1 ? lists[0] : undefined;
  };
  // Netflix publishes plural roles; accept standard singular roles too, but never infer a director from creators.
  const directors = series && !Object.hasOwn(movie, 'director') && !Object.hasOwn(movie, 'directors') ? [] : role('director', 'directors'), actors = role('actor', 'actors');
  return directors && actors ? validateFilmCredits({ directors, actors }) : undefined;
}
function validCache(value: unknown, now: number): value is MetadataCache {
  if (!object(value) || !Number.isFinite(value.expiresAt) || Number(value.expiresAt) <= now || !object(value.result)) return false;
  const result = value.result;
  if (result.kind === 'missing') return value.parserVersion === 2 && Number(value.expiresAt) <= now + DAY;
  return result.kind === 'matched' && ['movie', 'series'].includes(String(result.mediaType)) && typeof result.title === 'string' &&
    result.title.length <= 300 && !!normaliseTitle(result.title) && !/[\u0000-\u001f]/.test(result.title) &&
    (result.mediaType === 'movie' ? Number.isInteger(result.year) && Number(result.year) >= 1888 && Number(result.year) <= new Date(now).getUTCFullYear() + 1 :
      result.year === undefined && (validateFilmCredits(result.credits)?.actors.length ?? 0) >= 3) &&
    (result.credits === undefined || !!validateFilmCredits(result.credits)) &&
    Number.isFinite(result.checkedAt) && Number(result.checkedAt) <= now && Number(value.expiresAt) <= Number(result.checkedAt) + 30 * DAY;
}

/** Read only public JSON-LD identity/type and the title's visible metadata header. */
export function parseNetflixMetadata(html: string, requestedId: string, now = Date.now()): CachedMetadata {
  if (!ID.test(requestedId) || !Number.isFinite(now) || html.length > MAX_HTML)
    throw new MetadataFailure('The public title metadata request was invalid or too large.');
  const nodes: Record<string, unknown>[] = [];
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const clean = withoutComments.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (_script, attributes: string, body: string) => {
    if (attribute(attributes, 'type')?.toLowerCase() === 'application/ld+json') {
      if (body.length > 262144) throw new MetadataFailure('The public title metadata was too large.');
      try { nodes.push(...schemaNodes(JSON.parse(body))); }
      catch { throw new MetadataFailure('The public title page returned invalid structured metadata.'); }
    }
    return '';
  }).replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  if (/<\/?(?:script|style)\b|<!--/i.test(clean)) throw new MetadataFailure('The public title HTML was incomplete.');
  const bound = nodes.filter(node => typeof node.url === 'string' && netflixUrlId(node.url) === requestedId);
  const series = bound.length > 0 && bound.every(node => schemaTypes(node['@type']).includes('TVSeries') && !schemaTypes(node['@type']).includes('Movie'));
  const movies = bound.filter(node => schemaTypes(node['@type']).includes(series ? 'TVSeries' : 'Movie'));
  if (!movies.length) {
    throw new MetadataFailure('Public title metadata is unavailable for this Netflix identity.');
  }
  const names = new Set(movies.map(node => typeof node.name === 'string' ? normaliseTitle(node.name) : ''));
  if (names.size !== 1 || names.has('') || (!series && bound.some(node => schemaTypes(node['@type']).includes('TVSeries'))))
    throw new MetadataFailure('The public title page contained conflicting title identities.');
  const title = movies[0].name as string;
  if (title.length > 300 || /[\u0000-\u001f]/.test(title)) throw new MetadataFailure('The public title name was invalid.');
  const available = movies.map(movie => movieCredits(movie, series));
  const credits = available.every(value => value && JSON.stringify(value) === JSON.stringify(available[0])) ? available[0] : undefined;
  // Never call a series' latest-season display year its start year. Without cast proof it remains unsupported.
  if (series && (!credits || credits.actors.length < 3)) return { kind: 'missing' };
  const divs = [...clean.matchAll(/<\/?div\b[^>]*>/gi)];
  const metadata = divs.filter(match => !/^<\//.test(match[0]) && attribute(match[0].slice(4, -1), 'data-uia') === 'metadata');
  if (metadata.length !== 1) throw new MetadataFailure('A single public title metadata header was not available.');
  const start = metadata[0]; let depth = 0, end: number | undefined;
  for (const tag of divs) {
    if (tag.index! < start.index!) continue;
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) { end = tag.index; break; }
  }
  if (end === undefined || end - start.index! > 65536) throw new MetadataFailure('The public title metadata header was incomplete.');
  const header = clean.slice(start.index! + start[0].length, end);
  const headings = [...header.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)];
  if (headings.length !== 1 || normaliseTitle(decodedText(headings[0][1])) !== normaliseTitle(title))
    throw new MetadataFailure('The public title heading did not match its structured identity.');
  if (series) return { kind: 'matched', title, mediaType: 'series', checkedAt: now, credits: credits! };
  const afterHeading = header.slice(headings[0].index! + headings[0][0].length);
  const list = afterHeading.match(/<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/i);
  const firstItem = list && !/<ul\b/i.test(list[1]) ? list[1].match(/^\s*<li\b[^>]*>([\s\S]*?)<\/li\s*>/i) : undefined;
  const yearText = firstItem ? decodedText(firstItem[1]) : '';
  const year = Number(yearText);
  if (!/^\d{4}$/.test(yearText) || year < 1888 || year > new Date(now).getUTCFullYear() + 1)
    throw new MetadataFailure('The public movie release year was not available.');
  // Duplicate bound nodes must agree on credits; missing/conflicting optional credits cannot establish an edition match.
  return { kind: 'matched', title, mediaType: 'movie', year, checkedAt: now, ...(credits ? { credits } : {}) };
}

function retryTime(response: Response): number | undefined {
  const hint = response.headers.get('Retry-After'); if (!hint || hint.length > 64) return undefined;
  const at = /^\d{1,10}$/.test(hint) ? Date.now() + Number(hint) * 1000 : Date.parse(hint);
  return Number.isSafeInteger(at) && at >= Date.now() ? at : undefined;
}

export class NetflixMetadataResolver {
  private readonly pending = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = false;
  private nextAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly repo: Repository,
    private readonly getEligibility: () => Promise<{ enabled: boolean; cacheOnly: boolean }>,
    private readonly fetcher = fetch) {}

  async resolve(ref: PlatformTitleRef, demand: () => boolean, requireCredits = false): Promise<NetflixMetadataResult> {
    if (ref.platformId !== 'netflix') return { kind: 'missing' };
    if (typeof ref.titleId !== 'string' || !ID.test(ref.titleId)) return deferred('provider', 'The Netflix title identity was invalid.');
    const key = cacheKey(ref.titleId);
    try {
      const cached = await this.repo.get<MetadataCache>('resolutions', key);
      if (validCache(cached, Date.now()) && (!requireCredits || cached.result.kind !== 'matched' || cached.result.credits || cached.creditsChecked === true)) return cached.result;
      const settings = await this.getEligibility();
      if (!settings.enabled || settings.cacheOnly || !demand()) return deferred('busy', 'Automatic title matching is paused or the title is no longer visible.');
      if (offline()) return deferred('offline', 'Offline. Public title metadata will be retried when connected.');
      const old = this.pending.get(key); if (old) { old.demands.add(demand); return old.promise; }
      if (this.pending.size >= 100) return deferred('busy', 'Public title metadata lookups are busy.', Date.now() + 1000);
      let complete!: (value: NetflixMetadataResult) => void;
      const promise = new Promise<NetflixMetadataResult>(resolve => { complete = resolve; });
      const job = { key, titleId: ref.titleId, demands: new Set([demand]), promise, complete };
      this.pending.set(key, job); this.queue.push(job); this.schedule(); return promise;
    } catch { return deferred('provider', 'Public title metadata could not access local storage or settings.'); }
  }
  private active(job: Job): boolean { return [...job.demands].some(demand => demand()); }
  private schedule(): void {
    if (this.running || this.timer || !this.queue.length) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, Math.max(0, this.nextAt - Date.now()));
  }
  private async flush(): Promise<void> {
    if (this.running || !this.queue.length) return;
    this.running = true; const job = this.queue.shift()!;
    try { job.complete(this.active(job) ? await this.request(job) : deferred('busy', 'The title is no longer visible.')); }
    catch { job.complete(deferred('provider', 'Public title metadata is temporarily unavailable.')); }
    finally { this.pending.delete(job.key); this.running = false; this.schedule(); }
  }
  private async reserve(): Promise<{ id: string } | { blocked: NetflixMetadataResult }> {
    const now = Date.now();
    return await this.repo.transaction(['state'], async tx => {
      const old = await txGet<SourceState>(tx, 'state', TRANSPORT) ?? { nextAt: 0, leaseUntil: 0, failures: 0, cooldownUntil: 0, lastClock: 0 };
      if (now + 60000 < old.lastClock) return { blocked: deferred('provider', 'The system clock moved backwards. Public metadata lookups are paused.', old.lastClock) };
      if (old.cooldownUntil > now) return { blocked: deferred('provider', 'Public title metadata is cooling down.', old.cooldownUntil) };
      if (old.leaseUntil > now || old.nextAt > now) return { blocked: deferred('busy', 'A public title lookup is waiting or already running.', Math.max(old.leaseUntil, old.nextAt)) };
      const id = crypto.randomUUID(); this.nextAt = now + 500;
      txPut(tx, 'state', TRANSPORT, { ...old, leaseId: id, leaseUntil: now + 20000, nextAt: this.nextAt, lastClock: Math.max(old.lastClock, now) } satisfies SourceState);
      return { id };
    }, true);
  }
  private async finish(id: string, outcome: 'success' | 'cancelled' | MetadataFailure): Promise<number | undefined> {
    return await this.repo.transaction(['state'], async tx => {
      const old = await txGet<SourceState>(tx, 'state', TRANSPORT); if (!old || old.leaseId !== id) return undefined;
      let next = { ...old, nextAt: Math.max(old.nextAt, this.nextAt), leaseId: undefined, leaseUntil: 0 };
      if (outcome === 'success') next = { ...next, failures: 0, cooldownUntil: 0 };
      else if (outcome instanceof MetadataFailure) next = { ...next, failures: old.failures + 1,
        cooldownUntil: Math.max(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(old.failures, 6)), outcome.retryAfter ?? 0) };
      txPut(tx, 'state', TRANSPORT, next); return next.cooldownUntil || undefined;
    });
  }
  private async redirectDispatch(id: string): Promise<void> {
    const wait = this.nextAt - Date.now(); if (wait > 0) await pause(wait);
    await this.repo.transaction(['state'], async tx => {
      const state = await txGet<SourceState>(tx, 'state', TRANSPORT);
      if (!state || state.leaseId !== id || state.leaseUntil <= Date.now()) throw new MetadataFailure('The public metadata lookup lease expired.');
      this.nextAt = Date.now() + 500;
      txPut(tx, 'state', TRANSPORT, { ...state, nextAt: this.nextAt, lastClock: Math.max(state.lastClock, Date.now()) });
    }, true);
  }
  private async request(job: Job): Promise<NetflixMetadataResult> {
    let lease: string | undefined;
    try {
      const settings = await this.getEligibility();
      if (!settings.enabled || settings.cacheOnly || !this.active(job)) return deferred('busy', 'Automatic title matching is paused or the title is no longer visible.');
      if (offline()) return deferred('offline', 'Offline. Public title metadata will be retried when connected.');
      const claim = await this.reserve(); if ('blocked' in claim) return claim.blocked; lease = claim.id;
      const signal = AbortSignal.timeout(12000);
      // Public India/English route was inspected directly. It neither reads nor changes the account's region.
      let url = new URL(`https://www.netflix.com/in/title/${job.titleId}`), redirects = 0;
      let result: CachedMetadata;
      for (;;) {
        const current = await this.getEligibility();
        if (!current.enabled || current.cacheOnly || !this.active(job)) {
          await this.finish(lease, 'cancelled'); lease = undefined;
          return deferred('busy', 'The public title lookup was paused before dispatch.');
        }
        let response: Response;
        const fetcher = this.fetcher; // Native browser fetch must not receive the resolver as its receiver.
        this.nextAt = Math.max(this.nextAt, Date.now() + 500);
        try { response = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual', signal,
          headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8' } }); }
        catch { throw new MetadataFailure('The public Netflix title page could not be reached.', undefined, offline() ? 'offline' : 'provider'); }
        if (response.type === 'opaqueredirect' || response.status === 0) throw new MetadataFailure('The public Netflix page redirected without inspectable metadata.');
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('Location');
          if (!location || ++redirects > 2) throw new MetadataFailure('The public Netflix page redirected unexpectedly.');
          let next: URL;
          try { next = new URL(location, url); } catch { throw new MetadataFailure('The public Netflix redirect URL was invalid.'); }
          if (netflixUrlId(next.href) !== job.titleId) throw new MetadataFailure('The public Netflix page redirected away from the requested title.');
          await response.body?.cancel(); await this.redirectDispatch(lease); url = next; continue;
        }
        if (response.status === 404) { result = { kind: 'missing' }; break; }
        if (response.status !== 200) throw new MetadataFailure('The public Netflix title page is temporarily unavailable.', retryTime(response));
        if (response.url && netflixUrlId(response.url) !== job.titleId) throw new MetadataFailure('The public Netflix response was for another title.');
        if (!response.body || !/text\/html/i.test(response.headers.get('Content-Type') ?? '')) throw new MetadataFailure('The public Netflix title response was not an HTML page.');
        let html: string;
        try {
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
          for (;;) {
            const { done, value } = await reader.read(); if (done) break; length += value.length;
            if (length > MAX_HTML) { await reader.cancel(); throw new MetadataFailure('The public Netflix title page was too large.'); }
            chunks.push(value);
          }
          const bytes = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          html = new TextDecoder().decode(bytes);
        } catch (error) {
          if (error instanceof MetadataFailure) throw error;
          throw new MetadataFailure('The public Netflix title page was interrupted or invalid.');
        }
        result = parseNetflixMetadata(html, job.titleId); break;
      }
      await this.repo.put('resolutions', job.key, { expiresAt: result.kind === 'matched' ? result.checkedAt + 30 * DAY : Date.now() + DAY, result, creditsChecked: true, parserVersion: 2 } satisfies MetadataCache);
      await this.finish(lease, 'success'); lease = undefined; return result;
    } catch (error) {
      if (error instanceof MetadataFailure) {
        let retryAfter = error.retryAfter;
        if (lease) {
          try { retryAfter = await this.finish(lease, error); }
          catch { return deferred('provider', 'Public title metadata could not save its local service state.'); }
        }
        return deferred(error.reason, error.message, retryAfter);
      }
      if (lease) {
        try { await this.finish(lease, 'cancelled'); }
        catch { return deferred('provider', 'Public title metadata could not save its local service state.'); }
      }
      return deferred('provider', 'Public title metadata could not access local storage or settings.');
    }
  }
}
