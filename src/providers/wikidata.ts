import type { PlatformTitleRef } from '../shared/contracts';
import { Repository, txGet, txPut } from '../background/repository';

export type DirectIdResult =
  | { kind: 'matched'; imdbId: string; entityIds: string[]; checkedAt: number }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }
  | { kind: 'deferred'; reason: 'busy' | 'offline' | 'provider'; message: string; retryAfter?: number };

type CachedResult = Exclude<DirectIdResult, { kind: 'deferred' }>;
const PLATFORM_LOOKUPS = {
  netflix: { property: 'P1874', idColumn: 'netflixId' },
  hotstar: { property: 'P11049', idColumn: 'hotstarId' },
} as const;
type WikidataPlatform = keyof typeof PLATFORM_LOOKUPS;
interface SourceCache { expiresAt: number; result: CachedResult }
interface TransportState {
  nextDispatchAt: number;
  leaseUntil: number;
  leaseId?: string;
  failures: number;
  cooldownUntil: number;
  lastClock: number;
}
interface Job {
  key: string;
  platformId: WikidataPlatform;
  titleId: string;
  demands: Set<() => boolean>;
  promise: Promise<DirectIdResult>;
  complete(result: DirectIdResult): void;
}

const TRANSPORT = 'wikidata:transport';
const DAY = 86400000;
const ID = /^\d{1,12}$/;
const IMDB = /^tt\d{7,12}$/;
const ENTITY = /^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9]\d{0,11})$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const deferred = (reason: 'busy' | 'offline' | 'provider', message: string, retryAfter?: number): DirectIdResult =>
  ({ kind: 'deferred', reason, message, ...(retryAfter === undefined ? {} : { retryAfter }) });
const sourceKey = (ref: PlatformTitleRef) => JSON.stringify(['wikidata', ref.platformId, ref.titleId]);

class LookupFailure extends Error {
  constructor(readonly reason: 'offline' | 'provider', message: string, readonly retryAfter?: number) { super(message); }
}

function literal(value: unknown): string | undefined {
  if (!object(value) || value.type !== 'literal' || typeof value.value !== 'string' || value['xml:lang'] !== undefined ||
    (value.datatype !== undefined && value.datatype !== 'http://www.w3.org/2001/XMLSchema#string')) return undefined;
  return value.value;
}

function expectedColumns(head: unknown, columns: string[]): boolean {
  if (!object(head) || !Array.isArray(head.vars)) return false;
  const vars = head.vars;
  return vars.length === columns.length && columns.every(name => vars.includes(name));
}

/** A complete result set is needed: every distinct IMDb identity participates in ambiguity checks. */
export function parseWikidataResponse(raw: unknown, requestedIds: string[], now: number, platformId: WikidataPlatform = 'netflix'): Map<string, CachedResult> {
  const { idColumn } = PLATFORM_LOOKUPS[platformId];
  const columns = [idColumn, 'item', 'imdbId'];
  if (!Number.isFinite(now) || requestedIds.length < 1 || requestedIds.length > 20 || !requestedIds.every(id => typeof id === 'string' && ID.test(id)))
    throw new LookupFailure('provider', 'The title mapping request was invalid.');
  if (!object(raw) || !expectedColumns(raw.head, columns) ||
    !object(raw.results) || !Array.isArray(raw.results.bindings) || raw.results.bindings.length > 1000 ||
    raw.truncated === true || raw.partial === true || raw.hasMore === true || raw.results.truncated === true ||
    raw.error !== undefined || raw.warning !== undefined || raw.warnings !== undefined)
    throw new LookupFailure('provider', 'The title mapping service returned an unsupported response.');
  const requested = new Set(requestedIds);
  const found = new Map<string, Map<string, Set<string>>>();
  for (const row of raw.results.bindings) {
    if (!object(row) || Object.keys(row).some(key => !columns.includes(key)))
      throw new LookupFailure('provider', 'The title mapping service returned invalid identity data.');
    const titleId = literal(row[idColumn]), imdbId = literal(row.imdbId);
    const entity = object(row.item) && row.item.type === 'uri' && typeof row.item.value === 'string' ? row.item.value.match(ENTITY)?.[1] : undefined;
    if (!titleId || !ID.test(titleId) || !requested.has(titleId) || !imdbId || !IMDB.test(imdbId) || !entity)
      throw new LookupFailure('provider', 'The title mapping service returned invalid identity data.');
    const identities = found.get(titleId) ?? new Map<string, Set<string>>();
    const entities = identities.get(imdbId) ?? new Set<string>(); entities.add(entity);
    identities.set(imdbId, entities); found.set(titleId, identities);
  }
  const result = new Map<string, CachedResult>();
  for (const id of requested) {
    const identities = found.get(id);
    if (!identities?.size) result.set(id, { kind: 'missing' });
    else if (identities.size > 1) result.set(id, { kind: 'ambiguous' });
    else {
      const [imdbId, entities] = identities.entries().next().value!;
      result.set(id, { kind: 'matched', imdbId, entityIds: [...entities].sort(), checkedAt: now });
    }
  }
  return result;
}

function validCache(value: SourceCache | undefined, now: number): value is SourceCache {
  if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || !object(value.result)) return false;
  const result = value.result;
  if (result.kind === 'missing' || result.kind === 'ambiguous') return true;
  return result.kind === 'matched' && IMDB.test(result.imdbId) && Number.isFinite(result.checkedAt) &&
    result.checkedAt <= now && Array.isArray(result.entityIds) && result.entityIds.length > 0 &&
    result.entityIds.every(id => /^Q[1-9]\d{0,11}$/.test(id));
}

function retryAfter(response: Response, now: number): number | undefined {
  const hint = response.headers.get('Retry-After');
  if (!hint || hint.length > 64) return undefined;
  if (/^\d{1,10}$/.test(hint)) {
    const at = now + Number(hint) * 1000;
    return Number.isSafeInteger(at) ? at : undefined;
  }
  const at = Date.parse(hint);
  return Number.isFinite(at) && at >= now ? at : undefined;
}

export class WikidataResolver {
  private readonly pending = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private nextLocalDispatch = 0;
  constructor(private readonly repo: Repository,
    private readonly getEligibility: () => Promise<{ enabled: boolean; cacheOnly: boolean }>,
    private readonly fetcher = fetch) {}

  async resolve(ref: PlatformTitleRef, demand: () => boolean): Promise<DirectIdResult> {
    const { platformId } = ref;
    if (platformId !== 'netflix' && platformId !== 'hotstar') return { kind: 'missing' };
    if (typeof ref.titleId !== 'string' || !ID.test(ref.titleId))
      return deferred('provider', 'The streaming title identity is invalid.');
    const key = sourceKey(ref);
    try {
      const cached = await this.repo.get<SourceCache>('resolutions', key);
      if (validCache(cached, Date.now())) return cached.result;
      const settings = await this.getEligibility();
      if (!settings.enabled || settings.cacheOnly) return deferred('busy', 'Automatic title matching is paused in Settings.');
      if (!demand()) return deferred('busy', 'The title is no longer visible.');
      if (offline()) return deferred('offline', 'Offline. Automatic title matching will resume when connected.');
      const existing = this.pending.get(key);
      if (existing) { existing.demands.add(demand); return existing.promise; }
      if (this.pending.size >= 100) return deferred('busy', 'Automatic title matching is busy. Try again shortly.', Date.now() + 1000);
      let complete!: (result: DirectIdResult) => void;
      const promise = new Promise<DirectIdResult>(resolve => { complete = resolve; });
      const job: Job = { key, platformId, titleId: ref.titleId, demands: new Set([demand]), promise, complete };
      this.pending.set(key, job); this.queue.push(job); this.schedule();
      return promise;
    } catch { return deferred('provider', 'Automatic title matching could not access local storage or settings.'); }
  }

  private active(job: Job): boolean { return [...job.demands].some(demand => demand()); }
  private settle(job: Job, result: DirectIdResult): void {
    if (this.pending.get(job.key) !== job) return;
    this.pending.delete(job.key); job.complete(result);
  }
  private schedule(): void {
    if (this.running || this.timer || !this.queue.length) return;
    const delay = Math.max(50, this.nextLocalDispatch - Date.now());
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }
  private async flush(): Promise<void> {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const platformId = this.queue[0].platformId;
    const batch: Job[] = [];
    // Start with the oldest job's platform and keep other platforms queued for their own requests.
    for (let index = 0; index < this.queue.length && batch.length < 20;) {
      if (this.queue[index].platformId === platformId) batch.push(...this.queue.splice(index, 1));
      else index++;
    }
    try {
      const active: Job[] = [];
      for (const job of batch) {
        if (this.active(job)) active.push(job);
        else this.settle(job, deferred('busy', 'The title is no longer visible.'));
      }
      if (active.length) {
        const result = await this.requestBatch(platformId, active);
        for (const job of active) this.settle(job, result.get(job.titleId) ?? deferred('provider', 'The title mapping response was incomplete.'));
      }
    } catch {
      for (const job of batch) this.settle(job, deferred('provider', 'Automatic title matching is temporarily unavailable.'));
    } finally { this.running = false; this.schedule(); }
  }

  private async reserve(): Promise<{ id: string } | { blocked: DirectIdResult }> {
    const now = Date.now();
    return await this.repo.transaction(['state'], async tx => {
      const old = await txGet<TransportState>(tx, 'state', TRANSPORT) ??
        { nextDispatchAt: 0, leaseUntil: 0, failures: 0, cooldownUntil: 0, lastClock: 0 };
      if (now + 60000 < old.lastClock) return { blocked: deferred('provider', 'The system clock moved backwards. Automatic title matching is paused.', old.lastClock) };
      if (old.cooldownUntil > now) return { blocked: deferred('provider', 'The title mapping service is cooling down.', old.cooldownUntil) };
      if (old.leaseUntil > now) return { blocked: deferred('busy', 'A title mapping request is already in progress.', old.leaseUntil) };
      if (old.nextDispatchAt > now) return { blocked: deferred('busy', 'The title mapping service is waiting between requests.', old.nextDispatchAt) };
      const id = crypto.randomUUID();
      txPut(tx, 'state', TRANSPORT, { ...old, leaseId: id, leaseUntil: now + 20000,
        nextDispatchAt: now + 1000, lastClock: Math.max(old.lastClock, now) } satisfies TransportState);
      this.nextLocalDispatch = now + 1000;
      return { id };
    }, true);
  }
  private async finish(id: string, outcome: 'success' | 'cancelled' | LookupFailure): Promise<number | undefined> {
    return await this.repo.transaction(['state'], async tx => {
      const old = await txGet<TransportState>(tx, 'state', TRANSPORT);
      if (!old || old.leaseId !== id) return undefined;
      let next = { ...old, leaseId: undefined, leaseUntil: 0 };
      if (outcome === 'success') next = { ...next, failures: 0, cooldownUntil: 0 };
      else if (outcome instanceof LookupFailure) {
        const failures = old.failures + 1;
        const backoff = Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6));
        next = { ...next, failures, cooldownUntil: Math.max(Date.now() + backoff, outcome.retryAfter ?? 0) };
      }
      txPut(tx, 'state', TRANSPORT, next);
      return next.cooldownUntil || undefined;
    });
  }
  private async requestBatch(platformId: WikidataPlatform, jobs: Job[]): Promise<Map<string, DirectIdResult>> {
    const all = (result: DirectIdResult) => new Map(jobs.map(job => [job.titleId, result]));
    let lease: string | undefined;
    try {
      const settings = await this.getEligibility();
      if (!settings.enabled || settings.cacheOnly) return all(deferred('busy', 'Automatic title matching is paused in Settings.'));
      const active = jobs.filter(job => this.active(job));
      if (!active.length) return all(deferred('busy', 'The titles are no longer visible.'));
      if (offline()) return all(deferred('offline', 'Offline. Automatic title matching will resume when connected.'));
      const claim = await this.reserve();
      if ('blocked' in claim) return all(claim.blocked);
      lease = claim.id;
      const current = await this.getEligibility();
      const dispatch = active.filter(job => this.active(job));
      if (!current.enabled || current.cacheOnly || !dispatch.length) {
        await this.finish(lease, 'cancelled'); lease = undefined;
        return all(deferred('busy', 'Automatic title matching was paused before dispatch.'));
      }
      const ids = dispatch.map(job => job.titleId);
      const url = new URL('https://query.wikidata.org/sparql');
      const { property, idColumn } = PLATFORM_LOOKUPS[platformId];
      const values = ids.map(id => `"${id}"`).join(' ');
      const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/> SELECT ?${idColumn} ?item ?imdbId WHERE { ` +
        `VALUES ?${idColumn} { ${values} } ?item wdt:${property} ?${idColumn} ; wdt:P345 ?imdbId . }`;
      url.search = new URLSearchParams({ format: 'json', query }).toString();
      let response: Response;
      try {
        // Native browser fetch must not receive this resolver instance as its WebIDL receiver.
        const fetcher = this.fetcher;
        response = await fetcher(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
          signal: AbortSignal.timeout(12000), headers: { Accept: 'application/sparql-results+json',
            'Api-User-Agent': 'StreamCompanion/0.2 (personal browser extension; https://www.wikidata.org/)' } });
      } catch { throw new LookupFailure(offline() ? 'offline' : 'provider', 'The title mapping service could not be reached.'); }
      if (response.status === 429) throw new LookupFailure('provider', 'The title mapping service paused requests. Try again later.', retryAfter(response, Date.now()));
      if (response.status !== 200) throw new LookupFailure('provider', 'The title mapping service is temporarily unavailable.', retryAfter(response, Date.now()));
      if (!response.body) throw new LookupFailure('provider', 'The title mapping service returned an empty response.');
      let raw: unknown;
      try {
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.length;
          if (length > 262144) { await reader.cancel(); throw new LookupFailure('provider', 'The title mapping response was too large.'); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        raw = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        if (error instanceof LookupFailure) throw error;
        throw new LookupFailure(offline() ? 'offline' : 'provider', 'The title mapping service returned invalid or interrupted data.');
      }
      const now = Date.now(), parsed = parseWikidataResponse(raw, ids, now, platformId);
      await this.repo.transaction(['resolutions'], async tx => {
        for (const job of dispatch) {
          const result = parsed.get(job.titleId)!;
          txPut(tx, 'resolutions', job.key, { result, expiresAt: now + (result.kind === 'matched' ? 30 * DAY : DAY) } satisfies SourceCache);
        }
      });
      await this.finish(lease, 'success'); lease = undefined;
      const result = all(deferred('busy', 'The title is no longer visible.'));
      for (const [id, value] of parsed) result.set(id, value);
      return result;
    } catch (error) {
      if (error instanceof LookupFailure) {
        let after = error.retryAfter;
        if (lease) {
          try { after = await this.finish(lease, error); }
          catch { return all(deferred('provider', 'Automatic title matching could not save its service state locally.')); }
        }
        return all(deferred(error.reason, error.message, after));
      }
      if (lease) {
        try { await this.finish(lease, 'cancelled'); }
        catch { return all(deferred('provider', 'Automatic title matching could not save its service state locally.')); }
      }
      return all(deferred('provider', 'Automatic title matching could not access local storage or settings.'));
    }
  }
}
