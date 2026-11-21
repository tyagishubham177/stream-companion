import 'fake-indexeddb/auto';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { Repository } from '../../src/background/repository';
import { ImdbRatings, ImdbRatingsUnavailable } from '../../src/providers/imdb-ratings';

const header = 'tconst\taverageRating\tnumVotes\n';
const matrix = 'tt0133093\t8.7\t1800000\n';
const dinosaurs = 'tt32493765\t7.5\t9509\n';
const day = 24 * 60 * 60 * 1000;

function gzip(tsv = header + matrix + dinosaurs): Response {
  return new Response(Uint8Array.from(gzipSync(tsv)));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture() {
  const repo = new Repository(`imdb-snapshot-${crypto.randomUUID()}`);
  let now = Date.UTC(2026, 10, 21);
  const fetcher = vi.fn<typeof fetch>(async () => gzip());
  const run = () => new ImdbRatings(repo, fetcher, () => now);
  return { repo, run, fetcher, now: () => now, advance: (ms: number) => { now += ms; } };
}

it('shares one anonymous HTTPS download across concurrent title IDs and reuses it after a worker restart', async () => {
  const { fetcher, run, now } = fixture();
  const ratings = run();
  await expect(Promise.all([ratings.lookup('tt0133093', false), ratings.lookup('tt32493765', false)])).resolves.toEqual([
    { score: 8.7, votes: 1800000, fetchedAt: now() }, { score: 7.5, votes: 9509, fetchedAt: now() },
  ]);
  await expect(run().lookup('tt0000007', false)).resolves.toEqual({ score: null, votes: null, fetchedAt: now() });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://datasets.imdbws.com/title.ratings.tsv.gz', expect.objectContaining({
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
  }));
});

it('distinguishes title IDs of different lengths even when their numeric value is the same', async () => {
  const { fetcher, run } = fixture();
  fetcher.mockResolvedValueOnce(gzip(header + 'tt0133093\t8.7\t100\ntt00133093\t5.0\t20\ntt000001234567\t10.0\t50\n'));
  const ratings = run();
  await expect(ratings.lookup('tt0133093', false)).resolves.toMatchObject({ score: 8.7, votes: 100 });
  await expect(ratings.lookup('tt00133093', false)).resolves.toMatchObject({ score: 5, votes: 20 });
  await expect(ratings.lookup('tt000001234567', false)).resolves.toMatchObject({ score: 10, votes: 50 });
});

it('refreshes after a day and picks up updated ratings and rows that were previously absent', async () => {
  const { fetcher, run, advance, now } = fixture();
  fetcher.mockResolvedValueOnce(gzip(header + matrix));
  const ratings = run();
  await expect(ratings.lookup('tt32493765', false)).resolves.toMatchObject({ score: null });
  advance(day - 1);
  await expect(ratings.lookup('tt32493765', false)).resolves.toMatchObject({ score: null });
  advance(1);
  fetcher.mockResolvedValueOnce(gzip(header + 'tt0133093\t8.6\t1800100\n' + dinosaurs));
  await expect(ratings.lookup('tt32493765', false)).resolves.toEqual({ score: 7.5, votes: 9509, fetchedAt: now() });
  await expect(ratings.lookup('tt0133093', false)).resolves.toEqual({ score: 8.6, votes: 1800100, fetchedAt: now() });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps the last verified dataset on a failed refresh and remembers the retry interval across restarts', async () => {
  const { fetcher, run, advance, now } = fixture();
  const previous = now();
  await run().lookup('tt0133093', false);
  advance(day);
  fetcher.mockRejectedValueOnce(new TypeError('Network disconnected'));
  await expect(run().lookup('tt0133093', false)).resolves.toMatchObject({ score: 8.7, fetchedAt: previous });
  await expect(run().lookup('tt32493765', false)).resolves.toMatchObject({ score: 7.5, fetchedAt: previous });
  await expect(run().lookup('tt0000007', false)).rejects.toBeInstanceOf(ImdbRatingsUnavailable);
  expect(fetcher).toHaveBeenCalledTimes(2);
  advance(15 * 60 * 1000);
  await expect(run().lookup('tt32493765', false)).resolves.toMatchObject({ score: 7.5, fetchedAt: now() });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('uses a stale snapshot in cache-only mode and never starts a download', async () => {
  const { fetcher, run, advance, now } = fixture();
  await expect(run().lookup('tt0133093', true)).rejects.toBeInstanceOf(ImdbRatingsUnavailable);
  expect(fetcher).not.toHaveBeenCalled();
  const previous = now();
  await run().lookup('tt0133093', false);
  advance(2 * day);
  await expect(run().lookup('tt0133093', true)).resolves.toMatchObject({ score: 8.7, fetchedAt: previous });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('serves the last good score if writing an updated snapshot fails', async () => {
  const { repo, run, advance, now, fetcher } = fixture();
  const ratings = run();
  const fetchedAt = now();
  await ratings.lookup('tt0133093', false);
  advance(day);
  fetcher.mockResolvedValueOnce(gzip(header + 'tt0133093\t8.8\t2000000\n'));
  const transaction = repo.transaction.bind(repo);
  vi.spyOn(repo, 'transaction').mockImplementationOnce(transaction).mockRejectedValueOnce(new Error('Local storage transaction failed.'));
  await expect(ratings.lookup('tt0133093', false)).resolves.toEqual({ score: 8.7, votes: 1800000, fetchedAt });
  await expect(ratings.lookup('tt0000007', false)).rejects.toBeInstanceOf(ImdbRatingsUnavailable);
});

it.each([
  { name: 'header-only', response: () => gzip(header) },
  { name: 'unexpected header', response: () => gzip('title\taverageRating\tnumVotes\n' + matrix) },
  { name: 'invalid row', response: () => gzip(header + matrix + 'tt32493765\t17.5\t9509\n') },
  { name: 'duplicate title', response: () => gzip(header + matrix + matrix) },
  { name: 'truncated gzip', response: () => new Response(Uint8Array.from(gzipSync(header + matrix).subarray(0, -8))) },
  { name: 'partial HTTP response', response: () => new Response(Uint8Array.from(gzipSync(header + matrix)), { status: 206 }) },
])('rejects a $name dataset without treating the title as unrated', async ({ response }) => {
  const { fetcher, run } = fixture();
  fetcher.mockResolvedValueOnce(response());
  await expect(run().lookup('tt0133093', false)).rejects.toBeInstanceOf(ImdbRatingsUnavailable);
  await expect(run().lookup('tt0133093', true)).rejects.toBeInstanceOf(ImdbRatingsUnavailable);
});

it('clears the saved snapshot and prevents an already-started refresh from recreating it', async () => {
  const { fetcher, run, advance } = fixture();
  const ratings = run();
  await ratings.lookup('tt0133093', false);
  advance(day);
  const started = deferred<void>();
  let signal: AbortSignal | undefined;
  const response = deferred<Response>();
  fetcher.mockImplementationOnce(async (_url, options) => {
    signal = options?.signal ?? undefined;
    started.resolve();
    return response.promise;
  });
  const lookup = ratings.lookup('tt0133093', false);
  const result = expect(lookup).rejects.toBeInstanceOf(ImdbRatingsUnavailable);
  await started.promise;
  await ratings.clear();
  expect(signal?.aborted).toBe(true);
  response.resolve(gzip());
  await result;
  await expect(run().lookup('tt0133093', true)).rejects.toBeInstanceOf(ImdbRatingsUnavailable);
});
