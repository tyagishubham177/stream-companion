import { RESOLVER_VERSION, titleKey, ratingKey, type Mapping, type TitleObservation, type LookupResult, type RatingRecord, type LookupState } from '../shared/contracts';
import { contradicts, hasStrongEvidence, observationFingerprint, supportedCandidate, usableYear } from '../shared/identity';
import { ratingCacheState } from '../shared/freshness';
import { parseDetail, parseSearch, ProviderError } from '../providers/omdb';
import { Repository, txGet, txPut } from './repository';
import { DAY, DeferredError, Scheduler } from './scheduler';
import type { Configuration } from './config';
import type { DirectIdResult } from '../providers/wikidata';

interface Resolution { expiresAt: number; state?: LookupState; attempts: number }
interface DirectIds { resolve(ref: TitleObservation['ref'], demand: () => boolean): Promise<DirectIdResult> }
export class Resolver {
  private readonly pending = new Map<string, { result: Promise<LookupResult>; demands: Set<() => boolean> }>();
  constructor(readonly repo: Repository, readonly scheduler: Scheduler, readonly config: Configuration, private readonly directIds?: DirectIds) {}
  async detail(id: string, explicit: boolean, retest = false): Promise<RatingRecord> {
    if (!retest) {
      const cached = await this.repo.get<RatingRecord>('ratings', ratingKey({ namespace: 'imdb', id }));
      if (cached && ratingCacheState(cached) === 'fresh') return cached;
    }
    const record = await this.scheduler.request({ i: id, plot: 'short' }, explicit, raw => parseDetail(raw, id, Date.now()), retest);
    await this.repo.put('ratings', ratingKey(record.subject), record); return record;
  }
  async lookup(o: TitleObservation, refresh = false, revision?: number, demand: () => boolean = () => true): Promise<LookupResult> {
    const fingerprint = observationFingerprint(o);
    const mapping = await this.repo.get<Mapping>('mappings', titleKey(o.ref));
    const resetEpoch = await this.repo.get<number>('state', 'mappingEpoch') ?? 0;
    const rev = mapping?.revision ?? 0;
    if (refresh && revision !== rev) throw new Error('The saved match changed. Reopen the title details.');
    const key = JSON.stringify([fingerprint, rev, resetEpoch, refresh]);
    const old = this.pending.get(key); if (old) { old.demands.add(demand); return old.result; }
    const demands = new Set([demand]);
    const isDemandActive = () => [...demands].some(test => test());
    const result: Promise<LookupResult> = this.resolve(o, mapping, refresh, resetEpoch, isDemandActive).then(async state => {
      const value = { state, fingerprint, revision: rev };
      const current = await this.repo.get<Mapping>('mappings', titleKey(o.ref));
      const currentRevision = current?.revision ?? 0;
      const changed = currentRevision !== rev;
      const sameAcceptedAutomatic = current?.method === 'automatic' && current.subject &&
        (value.state.kind === 'rated' || value.state.kind === 'unrated') && current.subject.id === value.state.record.subject.id;
      if ((await this.repo.get<number>('state', 'mappingEpoch') ?? 0) !== resetEpoch || (changed && !sameAcceptedAutomatic)) {
        // The caller will reattach after the mapping invalidation broadcast.
        return { state: { kind: 'needs_match', reason: 'contradiction' }, fingerprint, revision: currentRevision };
      }
      return { ...value, revision: currentRevision };
    });
    this.pending.set(key, { result, demands });
    try { return await result; } finally { this.pending.delete(key); }
  }
  private async resolve(o: TitleObservation, mapping: Mapping | undefined, refresh: boolean, resetEpoch: number, demand: () => boolean): Promise<LookupState> {
    const settings = await this.config.settings();
    if (!settings.enabled) return { kind: 'disabled' };
    let cache: RatingRecord | undefined;
    let directSnapshot: DirectIdResult | undefined;
    const revalidateSource = mapping?.method === 'automatic' && mapping.provenance?.source === 'wikidata' &&
      Date.now() - mapping.provenance.checkedAt >= 30 * DAY && !refresh && !settings.cacheOnly && !!this.directIds;
    if (revalidateSource) directSnapshot = await this.directIds!.resolve(o.ref, demand);
    // A temporary source outage does not invalidate a previously supported identity/cache.
    if (mapping?.subject && !(revalidateSource && directSnapshot?.kind !== 'deferred')) {
      // V1 decisions remain compatible; new lookup attempts use the current resolver version.
      if (mapping.method === 'automatic' && (mapping.resolverVersion < 1 || mapping.resolverVersion > RESOLVER_VERSION)) return { kind: 'needs_match', reason: 'insufficient_evidence' };
      if ((o.mediaType !== 'unknown' && mapping.evidence.mediaType !== 'unknown' && o.mediaType !== mapping.evidence.mediaType) ||
        (usableYear(o) !== undefined && usableYear(mapping.evidence) !== undefined && usableYear(o) !== usableYear(mapping.evidence)))
        return { kind: 'needs_match', reason: 'contradiction' };
      cache = await this.repo.get<RatingRecord>('ratings', ratingKey(mapping.subject));
      if (cache && contradicts(o, cache)) return { kind: 'needs_match', reason: 'contradiction' };
      if (cache && !refresh && ratingCacheState(cache) === 'fresh') return stateFromRecord(cache, mapping.method, mapping.provenance?.source);
      if (settings.cacheOnly) return cachedOrDeferred(cache, mapping.method, new DeferredError('provider', 'Cache-only mode is on. Turn it off in Settings to fetch ratings.'));
      if (!(await this.config.credential())) return cachedOrSetup(cache, mapping.method);
      try {
        if (refresh) {
          await this.repo.transaction(['state'], async tx => {
            const key = `refresh:${titleKey(o.ref)}`;
            const last = await txGet<number>(tx, 'state', key) ?? 0;
            if (Date.now() < last + 60000) throw new DeferredError('busy', 'Wait a minute before refreshing this title again.', last + 60000);
            txPut(tx, 'state', key, Date.now());
          });
        }
        const id = mapping.subject.id;
        const record = await this.scheduler.request({ i: id, plot: 'short' }, refresh, raw => parseDetail(raw, id, Date.now()), false, demand);
        await this.repo.put('ratings', ratingKey(record.subject), record);
        if (contradicts(o, record)) return { kind: 'needs_match', reason: 'contradiction' };
        return stateFromRecord(record, mapping.method, mapping.provenance?.source);
      } catch (error) { return cachedOrDeferred(cache, mapping.method, error); }
    }
    if (refresh) return { kind: 'needs_match', reason: 'insufficient_evidence' };
    if (!(await this.config.credential())) return { kind: 'setup_required' };
    if (settings.cacheOnly) return { kind: 'needs_match', reason: 'insufficient_evidence' };
    if (this.directIds) {
      const direct = directSnapshot ?? await this.directIds.resolve(o.ref, demand);
      if (direct.kind === 'matched') {
        if (mapping?.rejected.includes(direct.imdbId)) return { kind: 'needs_match', reason: 'contradiction' };
        const validationKey = JSON.stringify(['direct-validation', observationFingerprint(o), direct.imdbId, mapping?.revision ?? 0, resetEpoch, RESOLVER_VERSION]);
        const invalid = await this.repo.get<Resolution>('resolutions', validationKey);
        if (invalid?.state && invalid.expiresAt > Date.now()) return invalid.state;
        try {
          const cached = await this.repo.get<RatingRecord>('ratings', ratingKey({ namespace: 'imdb', id: direct.imdbId }));
          const record = cached && ratingCacheState(cached) === 'fresh' ? cached :
            await this.scheduler.request({ i: direct.imdbId, plot: 'short' }, false, raw => parseDetail(raw, direct.imdbId, Date.now()), false, demand);
          await this.repo.put('ratings', ratingKey(record.subject), record);
          if (contradicts(o, record)) return { kind: 'needs_match', reason: 'contradiction' };
          const accepted = await this.repo.transaction(['mappings', 'state'], async tx => {
            const current = await txGet<Mapping>(tx, 'mappings', titleKey(o.ref));
            if ((current?.revision ?? 0) !== (mapping?.revision ?? 0) ||
              (await txGet<number>(tx, 'state', 'mappingEpoch') ?? 0) !== resetEpoch || current?.rejected.includes(direct.imdbId)) return false;
            txPut(tx, 'mappings', titleKey(o.ref), { ref: o.ref, subject: record.subject, revision: (current?.revision ?? 0) + 1,
              evidence: o, method: 'automatic', rejected: current?.rejected ?? [], resolverVersion: RESOLVER_VERSION,
              provenance: { source: 'wikidata', entityIds: direct.entityIds, checkedAt: direct.checkedAt } } satisfies Mapping);
            return true;
          }, true);
          if (accepted) return stateFromRecord(record, 'automatic', 'wikidata');
          const winner = await this.repo.get<Mapping>('mappings', titleKey(o.ref));
          return winner?.method === 'automatic' && winner.subject?.id === record.subject.id
            ? stateFromRecord(record, 'automatic', winner.provenance?.source) : { kind: 'needs_match', reason: 'contradiction' };
        } catch (error) {
          if (error instanceof ProviderError && ['not_found', 'identity'].includes(error.kind)) {
            const state: LookupState = { kind: 'needs_match', reason: error.kind === 'identity' ? 'contradiction' : 'not_found' };
            await this.repo.put('resolutions', validationKey, { state, attempts: 1, expiresAt: Date.now() + DAY });
            return state;
          }
          return cachedOrDeferred(undefined, 'automatic', error);
        }
      }
      if (!hasStrongEvidence(o)) {
        if (direct.kind === 'deferred') return { kind: 'deferred', reason: direct.reason, message: direct.message, retryAfter: direct.retryAfter };
        return { kind: 'needs_match', reason: direct.kind === 'ambiguous' ? 'ambiguous' : 'not_found' };
      }
    }
    if (!hasStrongEvidence(o)) return { kind: 'needs_match', reason: 'insufficient_evidence' };
    const fingerprint = observationFingerprint(o);
    const resolutionKey = JSON.stringify([fingerprint, mapping?.revision ?? 0, resetEpoch, RESOLVER_VERSION]);
    const previous = await this.repo.get<Resolution>('resolutions', resolutionKey);
    if (previous?.state?.kind === 'needs_match' && previous.expiresAt > Date.now()) return previous.state;
    const save = async (state: LookupState) => {
      const current = await this.repo.get<Resolution>('resolutions', resolutionKey);
      await this.repo.put('resolutions', resolutionKey, { state, attempts: current?.attempts ?? 0, expiresAt: Date.now() + (state.kind === 'needs_match' && state.reason === 'ambiguous' ? DAY : 6 * 3600000) });
      return state;
    };
    // An independent attempt counter bounds crash recovery without caching transient failures as misses.
    const automaticRequest = async <T>(params: Record<string, string>, decode: (raw: unknown) => T): Promise<T> => {
      await this.repo.transaction(['resolutions'], async tx => {
        const old = await txGet<Resolution>(tx, 'resolutions', resolutionKey);
        const attempts = old && old.expiresAt > Date.now() ? old.attempts : 0;
        if (attempts >= 3) throw new DeferredError('provider', 'Automatic matching has used its attempt limit. Use Match title to continue.');
        txPut(tx, 'resolutions', resolutionKey, { attempts: attempts + 1, expiresAt: Date.now() + 6 * 3600000 });
      }, true);
      try { return await this.scheduler.request(params, false, decode, false, demand); }
      catch (error) {
        if (error instanceof DeferredError) await this.repo.transaction(['resolutions'], async tx => {
          const old = await txGet<Resolution>(tx, 'resolutions', resolutionKey);
          if (old) txPut(tx, 'resolutions', resolutionKey, { ...old, attempts: Math.max(0, old.attempts - 1) });
        });
        throw error;
      }
    };
    try {
      const result = await automaticRequest({ s: o.displayTitle, y: String(usableYear(o)), type: o.mediaType, page: '1' }, raw => parseSearch(raw, 1));
      // An incomplete candidate set cannot establish a unique identity.
      if (result.total > result.candidates.length) return await save({ kind: 'needs_match', reason: 'ambiguous' });
      const candidates = result.candidates.filter(c => supportedCandidate(o, c) && !mapping?.rejected.includes(c.id));
      if (candidates.length !== 1) return await save({ kind: 'needs_match', reason: candidates.length ? 'ambiguous' : 'not_found' });
      const selectedId = candidates[0].id;
      const cached = await this.repo.get<RatingRecord>('ratings', ratingKey({ namespace: 'imdb', id: selectedId }));
      const record = cached && ratingCacheState(cached) === 'fresh' ? cached :
        await automaticRequest({ i: selectedId, plot: 'short' }, raw => parseDetail(raw, selectedId, Date.now()));
      await this.repo.put('ratings', ratingKey(record.subject), record);
      if (!supportedCandidate(o, { id: record.subject.id, title: record.title, year: record.year, mediaType: record.mediaType })) return await save({ kind: 'needs_match', reason: 'contradiction' });
      const accepted = await this.repo.transaction(['mappings', 'state'], async tx => {
        const current = await txGet<Mapping>(tx, 'mappings', titleKey(o.ref));
        if ((current?.revision ?? 0) !== (mapping?.revision ?? 0) || (await txGet<number>(tx, 'state', 'mappingEpoch') ?? 0) !== resetEpoch) return false;
        txPut(tx, 'mappings', titleKey(o.ref), { ref: o.ref, subject: record.subject, revision: (current?.revision ?? 0) + 1,
          evidence: o, method: 'automatic', rejected: current?.rejected ?? [], resolverVersion: RESOLVER_VERSION } satisfies Mapping);
        return true;
      });
      if (accepted) return stateFromRecord(record, 'automatic');
      const winner = await this.repo.get<Mapping>('mappings', titleKey(o.ref));
      return winner?.method === 'automatic' && winner.subject?.id === record.subject.id
        ? stateFromRecord(record, 'automatic', winner.provenance?.source) : { kind: 'needs_match', reason: 'contradiction' };
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') return await save({ kind: 'needs_match', reason: 'not_found' });
      return cachedOrDeferred(undefined, 'automatic', error);
    }
  }
}
export function stateFromRecord(record: RatingRecord, method: 'manual' | 'automatic', identitySource?: 'wikidata'): LookupState {
  if (record.score === null) return { kind: 'unrated', record, ...(identitySource ? { identitySource } : {}) };
  return { kind: 'rated', record, stale: ratingCacheState(record) !== 'fresh', method, ...(identitySource ? { identitySource } : {}) };
}
function cachedOrSetup(cache: RatingRecord | undefined, method: 'manual' | 'automatic'): LookupState {
  if (cache && cache.score !== null && ratingCacheState(cache) !== 'expired') return stateFromRecord(cache, method);
  return { kind: 'setup_required' };
}
function cachedOrDeferred(cache: RatingRecord | undefined, method: 'manual' | 'automatic', error: unknown): LookupState {
  if (cache && cache.score !== null && ratingCacheState(cache) !== 'expired') return stateFromRecord(cache, method);
  if (error instanceof DeferredError) return { kind: 'deferred', reason: error.reason, retryAfter: error.retryAfter, message: error.message };
  if (error instanceof ProviderError) return { kind: 'deferred', reason: error.kind === 'not_found' || error.kind === 'identity' ? 'provider' : error.kind, message: error.message };
  return { kind: 'deferred', reason: 'storage', message: 'Local storage failed. New lookups are paused.' };
}
