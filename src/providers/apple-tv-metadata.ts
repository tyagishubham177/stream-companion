import type { Repository } from '../background/repository';
import { APPLE_TV_ORIGIN, appleObservationPath, appleTitlePath } from '../platforms/apple-tv/routes';
import type { TitleObservation } from '../shared/contracts';
import { validateFilmCredits, type FilmCredits } from '../shared/edition';
import { normaliseTitle } from '../shared/identity';

export type AppleTvMetadataResult =
  | { kind: 'matched'; title: string; mediaType: 'movie' | 'series'; year: number; checkedAt: number; credits?: FilmCredits }
  | { kind: 'missing' }
  | { kind: 'deferred'; reason: 'busy' | 'offline' | 'provider'; message: string; retryAfter?: number };

type Observation = Pick<TitleObservation, 'ref' | 'pagePath' | 'mediaType'>;
type Work = NonNullable<ReturnType<typeof appleTitlePath>>;
type CachedResult = Exclude<AppleTvMetadataResult, { kind: 'deferred' }>;
type Pending = { result: Promise<AppleTvMetadataResult>; demands: Set<() => boolean> };
const DAY = 86400000;
const MAX_HTML = 2 * 1024 * 1024;
const DISPATCH_GAP = 500;
const COOLDOWN_KEY = 'apple-tv-metadata:cooldown';
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validTitle = (value: unknown): value is string => typeof value === 'string' && value.length <= 300 &&
  !/[\u0000-\u001f]/.test(value) && !!normaliseTitle(value);
const validYear = (value: unknown, now: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1888 && value <= new Date(now).getUTCFullYear() + 5;
const deferred = (reason: 'busy' | 'offline' | 'provider', message: string, retryAfter?: number): AppleTvMetadataResult =>
  ({ kind: 'deferred', reason, message, ...(retryAfter === undefined ? {} : { retryAfter }) });

function requestedWork(observation: Observation): Work | null {
  if (observation.ref.platformId !== 'apple-tv') return null;
  const path = appleObservationPath(observation.pagePath);
  return path && path.titleId === observation.ref.titleId && path.mediaType === observation.mediaType ? path : null;
}

function sameWork(value: unknown, work: Work): boolean {
  if (typeof value !== 'string') return false;
  try {
    const path = appleTitlePath(new URL(value));
    return path?.titleId === work.titleId && path.mediaType === work.mediaType;
  } catch { return false; }
}

function attribute(source: string, name: string): string | undefined {
  const attributes = /([^\s<>"'=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>"'=]+)))?/g;
  const values = [...source.matchAll(attributes)].filter(match => match[1].toLowerCase() === name);
  if (values.length > 1) throw new Error('Conflicting metadata attributes.');
  const match = values[0];
  return match && (match[2] ?? match[3] ?? match[4] ?? '');
}

function nodes(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || Array.isArray(value) && value.length > 100) throw new Error('Unsupported metadata structure.');
  if (Array.isArray(value)) return value.flatMap(child => nodes(child, depth + 1));
  if (!object(value)) return [];
  return [value, ...(value['@graph'] === undefined ? [] : nodes(value['@graph'], depth + 1))];
}

function types(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((type): type is string => typeof type === 'string')
    .map(type => type.replace(/^https?:\/\/schema\.org\//, ''));
}

function credits(work: Record<string, unknown>): FilmCredits | undefined {
  const names = (value: unknown) => {
    if (value === undefined) return [];
    const role = Array.isArray(value) ? value : [value];
    if (role.length > 40 || !role.every(person => object(person) && types(person['@type']).includes('Person'))) return undefined;
    return role.map(person => person.name);
  };
  const actors = names(work.actor), directors = names(work.director);
  return actors?.length || directors?.length ? validateFilmCredits({ actors, directors }) : undefined;
}

/** Apple publishes the work and its canonical identity in separate markup on current title pages. */
export function parseAppleTvMetadata(html: string, observation: Observation, now = Date.now()): CachedResult {
  const work = requestedWork(observation);
  if (!work || !Number.isFinite(now) || html.length > MAX_HTML) throw new Error('Invalid Apple TV metadata request.');
  const structured: Record<string, unknown>[] = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (_script, attrs: string, body: string) => {
      if (attribute(attrs, 'type')?.toLowerCase() === 'application/ld+json') {
        if (body.length > 262144) throw new Error('Apple TV structured metadata was too large.');
        structured.push(...nodes(JSON.parse(body)));
      }
      return '';
    });
  const head = clean.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] ?? '';
  const canonical = [...head.matchAll(/<link\b([^>]*)>/gi)]
    .filter(([, attrs]) => attribute(attrs, 'rel')?.toLowerCase() === 'canonical')
    .map(([, attrs]) => attribute(attrs, 'href'));
  const candidates = structured.filter(node => types(node['@type']).some(type => type === 'Movie' || type === 'TVSeries'));
  if (candidates.length !== 1) throw new Error('A single Apple TV work was not available.');
  const [candidate] = candidates;
  const workTypes = types(candidate['@type']).filter(type => type === 'Movie' || type === 'TVSeries');
  const bindings = [...canonical, ...[candidate.url, candidate['@id']].filter(value => value !== undefined)];
  if (workTypes.length !== 1 || workTypes[0] !== (work.mediaType === 'movie' ? 'Movie' : 'TVSeries') ||
    !bindings.length || !bindings.every(value => sameWork(value, work)) || !validTitle(candidate.name))
    throw new Error('Apple TV metadata did not match the requested title.');
  if (candidate.datePublished === undefined) return { kind: 'missing' };
  const date = candidate.datePublished;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(date))
    throw new Error('Apple TV release date was invalid.');
  const published = new Date(date), year = published.getUTCFullYear();
  if (!validYear(year, now) || published.toISOString().slice(0, 10) !== date.slice(0, 10))
    throw new Error('Apple TV release date was invalid.');
  const publicCredits = credits(candidate);
  return { kind: 'matched', title: candidate.name, mediaType: work.mediaType, year, checkedAt: now,
    ...(publicCredits ? { credits: publicCredits } : {}) };
}

function cachedResult(value: unknown, work: Work, now: number): CachedResult | undefined {
  if (!object(value) || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= now ||
    !object(value.result)) return undefined;
  const result = value.result;
  if (result.kind === 'missing' && value.expiresAt <= now + DAY) return { kind: 'missing' };
  if (result.kind === 'matched' && result.mediaType === work.mediaType && validTitle(result.title) && validYear(result.year, now) &&
    typeof result.checkedAt === 'number' && Number.isFinite(result.checkedAt) && result.checkedAt <= now &&
    value.expiresAt <= result.checkedAt + 30 * DAY) {
    const publicCredits = validateFilmCredits(result.credits);
    return { kind: 'matched', title: result.title, mediaType: work.mediaType, year: result.year, checkedAt: result.checkedAt,
      ...(publicCredits ? { credits: publicCredits } : {}) };
  }
  return undefined;
}

async function htmlBody(response: Response): Promise<string> {
  if (!response.body || !/^text\/html(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Apple TV did not return an HTML page.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  const chunks: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_HTML) throw new Error('Apple TV HTML was too large.');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    return chunks.join('') + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

function retryTime(response: Response): number {
  const now = Date.now(), hint = response.headers.get('Retry-After');
  if (!hint || hint.length > 64) return now + 30000;
  const requested = /^\d{1,10}$/.test(hint) ? now + Number(hint) * 1000 : Date.parse(hint);
  return Number.isSafeInteger(requested) && requested > now ? Math.min(requested, now + DAY) : now + 30000;
}

export class AppleTvMetadataResolver {
  private readonly pending = new Map<string, Pending>();
  private tail = Promise.resolve();
  private nextAt = 0;

  constructor(private readonly repo: Repository,
    private readonly getEligibility: () => Promise<{ enabled: boolean; cacheOnly: boolean }>,
    private readonly fetcher = fetch) {}

  async resolve(observation: Observation, demand: () => boolean): Promise<AppleTvMetadataResult> {
    if (observation.ref.platformId !== 'apple-tv') return { kind: 'missing' };
    const work = requestedWork(observation);
    if (!work) return deferred('provider', 'The Apple TV title identity was invalid.');
    const key = JSON.stringify(['apple-tv-metadata', work.mediaType, work.titleId]);
    try {
      const cached = cachedResult(await this.repo.get('resolutions', key), work, Date.now());
      if (cached) return cached;
      const paused = await this.paused(demand);
      if (paused) return paused;
      const existing = this.pending.get(key);
      if (existing) { existing.demands.add(demand); return existing.result; }
      if (this.pending.size >= 32) return deferred('busy', 'Apple TV metadata lookups are busy.', Date.now() + 1000);
      const demands = new Set([demand]);
      const result = this.tail.then(() => this.load(key, observation, work, () => [...demands].some(active => active())))
        .catch(() => offline()
          ? deferred('offline', 'Offline. Apple TV metadata will be retried when connected.')
          : deferred('provider', 'Apple TV public title metadata could not be verified.'))
        .finally(() => { this.pending.delete(key); });
      this.pending.set(key, { result, demands });
      this.tail = result.then(() => undefined);
      return result;
    } catch { return deferred('provider', 'Apple TV metadata could not access local storage or settings.'); }
  }

  private async paused(demand: () => boolean): Promise<AppleTvMetadataResult | undefined> {
    const settings = await this.getEligibility();
    if (!settings.enabled || settings.cacheOnly || !demand())
      return deferred('busy', 'Automatic title matching is paused or the title is no longer visible.');
    if (offline()) return deferred('offline', 'Offline. Apple TV metadata will be retried when connected.');
    return undefined;
  }

  private async load(key: string, observation: Observation, work: Work, demand: () => boolean): Promise<AppleTvMetadataResult> {
    const delay = Math.min(DISPATCH_GAP, this.nextAt - Date.now());
    if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
    const cooldown = await this.repo.get<number>('state', COOLDOWN_KEY);
    const paused = await this.paused(demand);
    if (paused) return paused;
    if (typeof cooldown === 'number' && Number.isFinite(cooldown) && cooldown > Date.now())
      return deferred('provider', 'Apple TV metadata requests are paused by the provider.', cooldown);
    const url = new URL(work.pagePath, APPLE_TV_ORIGIN);
    this.nextAt = Date.now() + DISPATCH_GAP;
    const fetcher = this.fetcher;
    const response = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
    if (response.redirected || response.url && response.url !== url.href) {
      await response.body?.cancel();
      throw new Error('Unexpected Apple TV redirect.');
    }
    if (response.status === 429 || response.status === 503) {
      const retryAfter = retryTime(response);
      await response.body?.cancel();
      await this.repo.put('state', COOLDOWN_KEY, retryAfter);
      return deferred('provider', 'Apple TV metadata requests are paused by the provider.', retryAfter);
    }
    let result: CachedResult;
    if (response.status === 404) {
      await response.body?.cancel();
      result = { kind: 'missing' };
    }
    else if (response.status === 200) result = parseAppleTvMetadata(await htmlBody(response), observation);
    else {
      await response.body?.cancel();
      throw new Error('Apple TV title metadata was temporarily unavailable.');
    }
    const expiresAt = result.kind === 'matched' ? result.checkedAt + 30 * DAY : Date.now() + DAY;
    await this.repo.put('resolutions', key, { expiresAt, result });
    return result;
  }
}
