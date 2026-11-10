import { parseDetail, parseSearch, ProviderError } from '../providers/omdb';
import { ratingKey, type Candidate, type HotstarPosterOutcome, type HotstarPosterRatingRequest, type HotstarPosterRatingResult, type RatingRecord } from '../shared/contracts';
import { DAY_MS, ratingCacheState, ratingFreshFor } from '../shared/freshness';
import { eligibleHotstarPosterTitle } from '../shared/hotstar-poster-binding';
import { normaliseTitle } from '../shared/identity';
import type { Configuration } from './config';
import { idbRequest, txGet, txPut, type Repository } from './repository';
import { DeferredError, type Scheduler } from './scheduler';

type Poster = HotstarPosterRatingRequest;
type Result = HotstarPosterRatingResult;
type SearchFailure = Extract<HotstarPosterOutcome, 'ambiguous' | 'too_broad' | 'not_found'>;
type MatchFailure = SearchFailure | 'conflict';
type Match = { candidate: Pick<Candidate, 'id' | 'year'>; expiresAt: number };
type Association = Match | { candidate: null; outcome: MatchFailure; expiresAt: number };
type SearchOutcome = { candidate: Candidate } | { outcome: SearchFailure };
interface Pending {
  demands: Set<() => boolean>;
  result: Promise<Result>;
}

const MISS_TTL = 12 * 60 * 60 * 1000;
const MATCH_TTL = 30 * DAY_MS;
const TEMPORARY_RETRY_MS = 15_000;
const CACHE_EPOCH_KEY = 'ratingCacheEpoch';
const SEARCH_PAGE_SIZE = 10;
const SEARCH_PAGE_LIMIT = 4;
const retry = (expiresAt = Date.now() + TEMPORARY_RETRY_MS, outcome: 'paused' | 'retry' = 'retry'): Result =>
  ({ record: null, expiresAt, retryable: true, outcome });
const keyFor = (poster: Poster, version = 2) => JSON.stringify(['hotstar-poster-rating', version, poster.key]);

function sameTitle(poster: Poster, title: { title: string; mediaType: string }): boolean {
  return title.mediaType === poster.mediaType && normaliseTitle(title.title) === normaliseTitle(poster.title);
}

function sameWork(poster: Poster, candidate: Pick<Candidate, 'id' | 'year'>, record: RatingRecord): boolean {
  if (record.subject.id !== candidate.id || !sameTitle(poster, record)) return false;
  if (poster.mediaType === 'movie') return /^\d{4}$/.test(candidate.year) && candidate.year === record.year;
  const year = /^(\d{4})(?:[–-](\d{4})?)?$/;
  const searched = candidate.year.match(year);
  const detail = record.year.match(year);
  return !!searched && !!detail && searched[1] === detail[1] && (!searched[2] || !detail[2] || searched[2] === detail[2]);
}

export async function clearRatingCache(repo: Repository): Promise<void> {
  await repo.transaction(['ratings', 'state'], async tx => {
    const epoch = await txGet<number>(tx, 'state', CACHE_EPOCH_KEY) ?? 0;
    await idbRequest(tx.objectStore('ratings').clear());
    txPut(tx, 'state', CACHE_EPOCH_KEY, epoch + 1);
  });
}

/** Provisional ratings have their own expiring cache and never write title mappings. */
export class HotstarPosterRatings {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly repo: Repository, private readonly scheduler: Pick<Scheduler, 'request'>,
    private readonly config: Pick<Configuration, 'settings'>) {}

  lookup(poster: Poster, demand: () => boolean): Promise<Result> {
    if (!eligibleHotstarPosterTitle(poster.title)) return Promise.resolve({ record: null, expiresAt: Date.now() + MISS_TTL, outcome: 'not_found' });
    const key = keyFor(poster);
    const existing = this.pending.get(key);
    if (existing) { existing.demands.add(demand); return existing.result; }
    if (this.pending.size >= 80) return Promise.resolve(retry());
    const demands = new Set([demand]);
    const active = () => [...demands].some(isActive => isActive());
    const result = this.resolve(key, poster, active).catch(error => {
      if (error instanceof DeferredError || error instanceof ProviderError) {
        const retryAfter = error instanceof DeferredError ? error.retryAfter : undefined;
        const reason = error instanceof DeferredError ? error.reason : error.kind;
        return retry(Math.max(Date.now() + TEMPORARY_RETRY_MS, retryAfter ?? 0),
          reason === 'quota' || reason === 'budget' || reason === 'key' ? 'paused' : 'retry');
      }
      throw error;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { demands, result });
    return result;
  }

  private async resolve(key: string, poster: Poster, demand: () => boolean): Promise<Result> {
    const settings = await this.config.settings();
    if (!settings.enabled || !settings.ratingsEnabled || !settings.automaticMatching) return retry(undefined, 'paused');
    const now = Date.now();
    const epoch = await this.repo.get<number>('state', CACHE_EPOCH_KEY) ?? 0;
    const stored = await this.repo.get<Association>('resolutions', key);
    let cached = stored && stored.expiresAt > now ? stored : undefined;
    if (!cached) {
      // A complete positive search under the old rules still counts. Retry old misses.
      const legacy = await this.repo.get<Match | { candidate: null; expiresAt: number }>('resolutions', keyFor(poster, 1));
      if (legacy?.candidate && legacy.expiresAt > now) cached = { candidate: legacy.candidate, expiresAt: legacy.expiresAt };
    }
    if (cached?.candidate === null) return { record: null, expiresAt: cached.expiresAt, outcome: cached.outcome };

    if (cached?.candidate) {
      const record = await this.readRating(cached.candidate.id);
      if (record && sameWork(poster, cached.candidate, record) && ratingCacheState(record, now) === 'fresh') {
        if ((await this.repo.get<number>('state', CACHE_EPOCH_KEY) ?? 0) !== epoch) return retry();
        return this.result(record, cached.expiresAt, 'cache', now);
      }
    }
    if (settings.cacheOnly) return retry(undefined, 'paused');
    if (!demand()) return retry();

    const search = cached?.candidate ? cached : await this.findCandidate(poster, demand);
    if ('outcome' in search) return await this.saveMiss(key, search.outcome, epoch);
    const selected = search.candidate;
    const existingRating = await this.readRating(selected.id);
    const useCachedRating = existingRating && ratingCacheState(existingRating) === 'fresh' && sameWork(poster, selected, existingRating);
    const record = useCachedRating ? existingRating :
      await this.scheduler.request({ i: selected.id, plot: 'short' }, false,
        raw => parseDetail(raw, selected.id, Date.now()), false, demand, true);
    if (!sameWork(poster, selected, record)) return await this.saveMiss(key, 'conflict', epoch);
    const expiresAt = cached?.expiresAt ?? Date.now() + MATCH_TTL;
    const saved = await this.repo.transaction(['resolutions', 'ratings', 'state'], async tx => {
      if ((await txGet<number>(tx, 'state', CACHE_EPOCH_KEY) ?? 0) !== epoch) return false;
      txPut(tx, 'resolutions', key, { candidate: { id: selected.id, year: selected.year }, expiresAt } satisfies Association);
      if (!useCachedRating) txPut(tx, 'ratings', ratingKey(record.subject), record);
      return true;
    });
    return saved ? this.result(record, expiresAt, useCachedRating ? 'cache' : 'fresh') : retry();
  }

  private result(record: RatingRecord, associationExpiresAt: number, origin: 'fresh' | 'cache', now = Date.now()): Result {
    const expiresAt = Math.min(associationExpiresAt, record.fetchedAt + ratingFreshFor(record, now));
    return record.score === null ? { record: null, expiresAt, outcome: 'unrated' } : { record, expiresAt, origin };
  }

  private readRating(id: string): Promise<RatingRecord | undefined> {
    return this.repo.get<RatingRecord>('ratings', ratingKey({ namespace: 'imdb', id }));
  }

  private async saveMiss(key: string, outcome: MatchFailure, epoch: number): Promise<Result> {
    const expiresAt = Date.now() + MISS_TTL;
    const saved = await this.repo.transaction(['resolutions', 'state'], async tx => {
      if ((await txGet<number>(tx, 'state', CACHE_EPOCH_KEY) ?? 0) !== epoch) return false;
      txPut(tx, 'resolutions', key, { candidate: null, expiresAt, outcome } satisfies Association);
      return true;
    });
    return saved ? { record: null, expiresAt, outcome } : retry();
  }

  private async findCandidate(poster: Poster, demand: () => boolean): Promise<SearchOutcome> {
    const search = (page: number) => this.scheduler.request({ s: poster.title, type: poster.mediaType, page: String(page) },
      false, raw => parseSearch(raw, page), false, demand, true);
    let first: Awaited<ReturnType<typeof search>>;
    try { first = await search(1); }
    catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') return { outcome: 'not_found' };
      throw error;
    }
    const seen = new Set<string>();
    let exact: Candidate | undefined;
    const pages = Math.max(1, Math.ceil(first.total / SEARCH_PAGE_SIZE));
    for (let page = 1; page <= Math.min(pages, SEARCH_PAGE_LIMIT); page++) {
      const result = page === 1 ? first : await search(page);
      const expected = Math.min(SEARCH_PAGE_SIZE, first.total - (page - 1) * SEARCH_PAGE_SIZE);
      if (result.total !== first.total || result.entryIds.length !== expected)
        throw new ProviderError('provider', 'The rating service returned an incomplete title search.');
      for (const id of result.entryIds) {
        if (seen.has(id)) throw new ProviderError('provider', 'The rating service returned a repeated search entry.');
        seen.add(id);
      }
      for (const candidate of result.candidates) {
        if (!sameTitle(poster, candidate)) continue;
        if (exact) return { outcome: 'ambiguous' };
        exact = candidate;
      }
      if (pages > SEARCH_PAGE_LIMIT) return { outcome: 'too_broad' };
    }
    return exact ? { candidate: exact } : { outcome: 'not_found' };
  }
}
