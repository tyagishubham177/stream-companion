import { idbRequest, txGet, txPut, type Repository } from '../background/repository';
import { DAY_MS } from '../shared/freshness';

export const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
export const IMDB_RATINGS_FRESH_MS = DAY_MS;
const RETRY_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const PREFIX = 'imdb-ratings:';
const SNAPSHOT_KEY = `${PREFIX}snapshot`;
const HEADER = 'tconst\taverageRating\tnumVotes';
const TITLE_ID = /^tt\d{7,12}$/;
const RATING_ROW = /^(tt\d{7,12})\t([1-9]|10)(\.\d)?\t([1-9]\d{0,15})$/;

interface Snapshot { fetchedAt?: number; retryAfter?: number }
export interface Score { score: number | null; votes: number | null; fetchedAt: number }
interface Entry<T> { value: T }

export class ImdbRatingsUnavailable extends Error {
  constructor(message: string, readonly retryAfter?: number) { super(message); }
}

const fresh = (fetchedAt: number | undefined, now: number): boolean =>
  fetchedAt !== undefined && fetchedAt <= now && now - fetchedAt < IMDB_RATINGS_FRESH_MS;
const readyToRefresh = (snapshot: Snapshot | undefined, now: number): boolean =>
  !fresh(snapshot?.fetchedAt, now) && (snapshot?.retryAfter === undefined || snapshot.retryAfter <= now || snapshot.retryAfter - now > RETRY_MS);
const shardKey = (prefix: string) => `${PREFIX}${prefix}`;
const shardRange = () => IDBKeyRange.bound(shardKey('00'), shardKey('99'));

// A leading 1 keeps IMDb's leading zeros and ID length distinct. Each stored
// pair packs that ID and the score in tenths into one exact integer, plus the vote count.
const idNumber = (id: string): number => Number(`1${id.slice(2)}`);
const SCORE_BASE = 128;

async function readDataset(response: Response, signal: AbortSignal): Promise<Map<string, number[]>> {
  if (response.status !== 200 || !response.body || Number(response.headers.get('Content-Length')) > MAX_COMPRESSED_BYTES)
    throw new Error('IMDb did not return a complete ratings download.');

  const shards = new Map<string, number[]>();
  const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let foundHeader = false;
  let carry = '';
  let byteCount = 0;
  const addLine = (line: string) => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!foundHeader) {
      if (text !== HEADER) throw new Error('Unexpected IMDb ratings header.');
      foundHeader = true;
      return;
    }
    const row = RATING_ROW.exec(text);
    if (!row) throw new Error('Unexpected IMDb ratings row.');
    const [, id, integer, fraction = '', count] = row;
    const score = Number(integer) * 10 + Number(fraction[1] ?? 0);
    const votes = Number(count);
    if (score > 100 || !Number.isSafeInteger(votes)) throw new Error('Unexpected IMDb rating value.');
    const prefix = id.slice(2, 4);
    let shard = shards.get(prefix);
    if (!shard) { shard = []; shards.set(prefix, shard); }
    shard.push(idNumber(id) * SCORE_BASE + score, votes);
  };

  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      byteCount += chunk.value.byteLength;
      if (byteCount > MAX_EXPANDED_BYTES) throw new Error('IMDb ratings download exceeded the size limit.');
      const text = carry + decoder.decode(chunk.value, { stream: true });
      let start = 0;
      for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
        addLine(text.slice(start, newline));
        start = newline + 1;
      }
      carry = text.slice(start);
      if (carry.length > 64) throw new Error('Unexpected IMDb ratings row length.');
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined); // Preserve the original download or validation failure.
    throw error;
  } finally {
    reader.releaseLock();
  }
  carry += decoder.decode();
  if (carry) addLine(carry);
  if (!shards.size) throw new Error('IMDb ratings download contained no ratings.');
  for (const shard of shards.values()) {
    const ids = new Set<number>();
    for (let i = 0; i < shard.length; i += 2) {
      const id = Math.floor(shard[i] / SCORE_BASE);
      if (ids.has(id)) throw new Error('IMDb ratings download contained a repeated title.');
      ids.add(id);
    }
  }
  return shards;
}

/** One browser-local copy shared by all title lookups. */
export class ImdbRatings {
  private generation = 0;
  private downloading?: { controller: AbortController; work: Promise<boolean> };
  private clearing?: Promise<void>;

  constructor(private readonly repo: Repository, private readonly fetcher: typeof fetch = fetch,
    private readonly clock = Date.now) {}

  async lookup(id: string, cacheOnly: boolean): Promise<Score> {
    if (!TITLE_ID.test(id)) throw new Error('Invalid IMDb title ID.');
    await this.clearing;
    const generation = this.generation;
    let failure: ImdbRatingsUnavailable | undefined;
    if (!cacheOnly) {
      try { await this.refreshWhenDue(generation); }
      catch (error) {
        failure = error instanceof ImdbRatingsUnavailable ? error :
          new ImdbRatingsUnavailable('The IMDb ratings download could not be saved. Check browser storage and try again.', this.clock() + RETRY_MS);
      }
    }

    const { scores, snapshot } = await this.readSnapshot([id], generation);
    const score = scores.get(id);
    if (score) return score;
    if (failure) throw failure;
    if (cacheOnly) throw new ImdbRatingsUnavailable('An up-to-date IMDb ratings download is needed. Turn off cache-only mode to download it.');
    throw new ImdbRatingsUnavailable('The IMDb ratings download is temporarily unavailable. Try again later.', snapshot?.retryAfter);
  }

  /** Read saved scores immediately, including stale hits during a refresh. */
  async readCached(ids: readonly string[]): Promise<Map<string, Score>> {
    if (ids.some(id => !TITLE_ID.test(id))) throw new Error('Invalid IMDb title ID.');
    if (!ids.length) return new Map();
    await this.clearing;
    return (await this.readSnapshot(ids, this.generation)).scores;
  }

  async refreshIfDue(): Promise<boolean> {
    await this.clearing;
    return this.refreshWhenDue(this.generation);
  }

  private async readSnapshot(ids: readonly string[], generation: number): Promise<{ scores: Map<string, Score>; snapshot?: Snapshot }> {
    this.requireGeneration(generation);
    const db = await this.repo.open();
    const store = db.transaction('state').objectStore('state');
    const snapshot = (await idbRequest(store.get(SNAPSHOT_KEY)) as Entry<Snapshot> | undefined)?.value;
    const fetchedAt = snapshot?.fetchedAt;
    const scores = new Map<string, Score>();
    this.requireGeneration(generation);
    if (fetchedAt === undefined) return { scores, snapshot };

    const requestedShards = new Map<string, Map<number, string>>();
    for (const id of ids) {
      const prefix = id.slice(2, 4);
      let requested = requestedShards.get(prefix);
      if (!requested) { requested = new Map(); requestedShards.set(prefix, requested); }
      requested.set(idNumber(id), id);
    }

    const snapshotFresh = fresh(fetchedAt, this.clock());
    await Promise.all(Array.from(requestedShards, async ([prefix, requested]) => {
      const shard = (await idbRequest(store.get(shardKey(prefix))) as Entry<Float64Array> | undefined)?.value;
      if (shard) for (let i = 0; i < shard.length && requested.size; i += 2) {
        const packed = shard[i];
        const key = Math.floor(packed / SCORE_BASE);
        const id = requested.get(key);
        if (id === undefined) continue;
        scores.set(id, { score: (packed % SCORE_BASE) / 10, votes: shard[i + 1], fetchedAt });
        requested.delete(key);
      }
      if (snapshotFresh) {
        for (const id of requested.values()) scores.set(id, { score: null, votes: null, fetchedAt });
      }
    }));
    this.requireGeneration(generation);
    return { scores, snapshot };
  }

  clear(): Promise<void> {
    if (this.clearing) return this.clearing;
    this.generation++;
    this.downloading?.controller.abort();
    this.downloading = undefined;
    this.clearing = this.repo.transaction(['state'], async tx => {
      const store = tx.objectStore('state');
      store.delete(SNAPSHOT_KEY);
      store.delete(shardRange());
    }, true).finally(() => { this.clearing = undefined; });
    return this.clearing;
  }

  private requireGeneration(generation: number): void {
    if (generation !== this.generation) throw new ImdbRatingsUnavailable('The IMDb ratings cache was cleared. Try again.');
  }

  private async refreshWhenDue(generation: number): Promise<boolean> {
    const snapshot = await this.repo.get<Snapshot>('state', SNAPSHOT_KEY);
    this.requireGeneration(generation);
    return this.downloading?.work ?? (readyToRefresh(snapshot, this.clock()) ? this.refresh(generation) : false);
  }

  private refresh(generation: number): Promise<boolean> {
    if (this.downloading) return this.downloading.work;
    const controller = new AbortController();
    const work = this.download(generation, controller.signal).finally(() => {
      if (this.downloading?.controller === controller) this.downloading = undefined;
    });
    this.downloading = { controller, work };
    return work;
  }

  private async download(generation: number, cancel: AbortSignal): Promise<boolean> {
    const retryAfter = await this.repo.transaction(['state'], async tx => {
      const snapshot = await txGet<Snapshot>(tx, 'state', SNAPSHOT_KEY);
      this.requireGeneration(generation);
      const now = this.clock();
      if (!readyToRefresh(snapshot, now)) return;
      // Record the opportunity before dispatch so a service worker restart preserves the retry interval.
      const nextAttempt = now + RETRY_MS;
      txPut(tx, 'state', SNAPSHOT_KEY, { ...snapshot, retryAfter: nextAttempt } satisfies Snapshot);
      return nextAttempt;
    }, true);
    this.requireGeneration(generation);
    if (retryAfter === undefined) return false;

    let shards: Map<string, number[]>;
    try {
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
      const fetcher = this.fetcher;
      const response = await fetcher(IMDB_RATINGS_URL, { credentials: 'omit', referrerPolicy: 'no-referrer',
        redirect: 'error', cache: 'no-store', signal });
      shards = await readDataset(response, signal);
      signal.throwIfAborted();
    } catch {
      this.requireGeneration(generation);
      throw new ImdbRatingsUnavailable('The IMDb ratings download could not be loaded. Check your connection and try again later.', retryAfter);
    }

    await this.repo.transaction(['state'], async tx => {
      this.requireGeneration(generation);
      const store = tx.objectStore('state');
      store.delete(shardRange());
      for (const [prefix, values] of shards) txPut(tx, 'state', shardKey(prefix), Float64Array.from(values));
      txPut(tx, 'state', SNAPSHOT_KEY, { fetchedAt: this.clock() } satisfies Snapshot);
    }, true);
    this.requireGeneration(generation);
    return true;
  }
}
