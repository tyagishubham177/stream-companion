import { parseDetail, parseSearch, ProviderError } from '../providers/omdb';
import { ratingKey, type Candidate, type HotstarPosterRatingRequest, type HotstarPosterRatingResult, type RatingRecord } from '../shared/contracts';
import { DAY_MS, ratingCacheState, ratingFreshFor } from '../shared/freshness';
import { eligibleHotstarPosterTitle } from '../shared/hotstar-poster-binding';
import { normaliseTitle } from '../shared/identity';
import type { Configuration } from './config';
import { idbRequest, txGet, txPut, type Repository } from './repository';
import { DeferredError, type Scheduler } from './scheduler';

type Poster = HotstarPosterRatingRequest;
type Result = HotstarPosterRatingResult;
interface Association {
  candidate: Pick<Candidate, 'id' | 'year'> | null;
  expiresAt: number;
}
interface Pending {
  demands: Set<() => boolean>;
  result: Promise<Result>;
}

const MISS_TTL = 12 * 60 * 60 * 1000;
const MATCH_TTL = 30 * DAY_MS;
const TEMPORARY_RETRY_MS = 15_000;
const CACHE_EPOCH_KEY = 'ratingCacheEpoch';
const retry = (expiresAt = Date.now() + TEMPORARY_RETRY_MS): Result => ({ record: null, expiresAt, retryable: true });
const keyFor = (poster: Poster) => JSON.stringify(['hotstar-poster-rating', 1, poster.key]);

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
    if (!eligibleHotstarPosterTitle(poster.title)) return Promise.resolve({ record: null, expiresAt: Date.now() + MISS_TTL });
    const key = keyFor(poster);
    const existing = this.pending.get(key);
    if (existing) { existing.demands.add(demand); return existing.result; }
    if (this.pending.size >= 80) return Promise.resolve(retry());
    const demands = new Set([demand]);
    const active = () => [...demands].some(isActive => isActive());
    const result = this.resolve(key, poster, active).catch(error => {
      if (error instanceof DeferredError || error instanceof ProviderError) {
        const retryAfter = error instanceof DeferredError ? error.retryAfter : undefined;
        return retry(Math.max(Date.now() + TEMPORARY_RETRY_MS, retryAfter ?? 0));
      }
      throw error;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, { demands, result });
    return result;
  }

  private async resolve(key: string, poster: Poster, demand: () => boolean): Promise<Result> {
    const settings = await this.config.settings();
    if (!settings.enabled || !settings.ratingsEnabled || !settings.automaticMatching) return retry();
    const now = Date.now();
    const epoch = await this.repo.get<number>('state', CACHE_EPOCH_KEY) ?? 0;
    const stored = await this.repo.get<Association>('resolutions', key);
    const cached = stored && stored.expiresAt > now ? stored : undefined;
    if (cached?.candidate === null) return { record: null, expiresAt: cached.expiresAt };

    const candidate = cached?.candidate;
    if (candidate) {
      const record = await this.readRating(candidate.id);
      if (record && sameWork(poster, candidate, record) && ratingCacheState(record, now) === 'fresh') {
        if ((await this.repo.get<number>('state', CACHE_EPOCH_KEY) ?? 0) !== epoch) return retry();
        return this.result(record, cached.expiresAt, now);
      }
    }
    if (settings.cacheOnly || !demand()) return retry();

    const selected = candidate ?? await this.findCandidate(poster, demand);
    if (!selected) return await this.saveMiss(key);
    const existingRating = await this.readRating(selected.id);
    const record = existingRating && ratingCacheState(existingRating) === 'fresh' ? existingRating :
      await this.scheduler.request({ i: selected.id, plot: 'short' }, false,
        raw => parseDetail(raw, selected.id, Date.now()), false, demand, true);
    if (!sameWork(poster, selected, record)) return await this.saveMiss(key);
    const expiresAt = cached?.expiresAt ?? Date.now() + MATCH_TTL;
    const saved = await this.repo.transaction(['resolutions', 'ratings', 'state'], async tx => {
      if ((await txGet<number>(tx, 'state', CACHE_EPOCH_KEY) ?? 0) !== epoch) return false;
      txPut(tx, 'resolutions', key, { candidate: { id: selected.id, year: selected.year }, expiresAt } satisfies Association);
      if (existingRating !== record) txPut(tx, 'ratings', ratingKey(record.subject), record);
      return true;
    });
    return saved ? this.result(record, expiresAt) : retry();
  }

  private result(record: RatingRecord, associationExpiresAt: number, now = Date.now()): Result {
    const expiresAt = Math.min(associationExpiresAt, record.fetchedAt + ratingFreshFor(record, now));
    return { record: record.score === null ? null : record, expiresAt };
  }

  private readRating(id: string): Promise<RatingRecord | undefined> {
    return this.repo.get<RatingRecord>('ratings', ratingKey({ namespace: 'imdb', id }));
  }

  private async saveMiss(key: string): Promise<Result> {
    const expiresAt = Date.now() + MISS_TTL;
    await this.repo.put('resolutions', key, { candidate: null, expiresAt } satisfies Association);
    return { record: null, expiresAt };
  }

  private async findCandidate(poster: Poster, demand: () => boolean): Promise<Candidate | null> {
    const search = (page: number) => this.scheduler.request({ s: poster.title, type: poster.mediaType, page: String(page) },
      false, raw => parseSearch(raw, page), false, demand, true);
    const first = await search(1).catch(error => {
      if (error instanceof ProviderError && error.kind === 'not_found') return { candidates: [], total: 0 };
      throw error;
    });
    if (first.total > 20) return null;
    if (first.candidates.length !== Math.min(10, first.total))
      throw new ProviderError('provider', 'The rating service returned an incomplete title search.');
    let candidates = first.candidates;
    if (first.total > 10) {
      const second = await search(2);
      if (second.total !== first.total || second.candidates.length !== first.total - 10)
        throw new ProviderError('provider', 'The rating service returned an incomplete title search.');
      candidates = [...candidates, ...second.candidates];
    }
    if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length)
      throw new ProviderError('provider', 'The rating service returned a repeated search entry.');
    const exact = candidates.filter(candidate => sameTitle(poster, candidate));
    return exact.length === 1 ? exact[0] : null;
  }
}
