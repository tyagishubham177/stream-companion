import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { clearRatingCache, HotstarPosterRatings } from '../../src/background/hotstar-poster-ratings';
import { Repository } from '../../src/background/repository';
import { DeferredError, type Scheduler } from '../../src/background/scheduler';
import { parseDetail, ProviderError } from '../../src/providers/omdb';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, ratingKey, type HotstarPosterRatingRequest } from '../../src/shared/contracts';
import { eligibleHotstarPosterTitle } from '../../src/shared/hotstar-poster-binding';
import { normaliseTitle } from '../../src/shared/identity';
import { authoriseRequest, validateRequest } from '../../src/shared/validation';

const poster = (title = 'The Matrix', mediaType: 'movie' | 'series' = 'movie'): HotstarPosterRatingRequest =>
  ({ key: JSON.stringify(['fixture-art-v', normaliseTitle(title), mediaType]), title, mediaType });
const candidate = (id = 'tt0133093', title = 'The Matrix', year = '1999', type = 'movie') =>
  ({ imdbID: id, Title: title, Year: year, Type: type });
const search = (candidates: ReturnType<typeof candidate>[], total = candidates.length) =>
  ({ Response: 'True', Search: candidates, totalResults: String(total) });
const detail = (title = 'The Matrix', year = '1999', score = '8.7') =>
  ({ ...candidate('tt0133093', title, year), Response: 'True', imdbRating: score });
const decoys = (count: number, from = 0) => Array.from({ length: count }, (_, i) =>
  candidate(`tt${(i + from + 1).toString().padStart(7, '0')}`, `Synthetic other work ${i + from}`));
const active = () => true;

function fixture(upstream: (params: Record<string, string>) => unknown = params => params.s ? search([candidate()]) : detail()) {
  const repo = new Repository(`hotstar-poster-ratings-${crypto.randomUUID()}`);
  const config = { settings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) };
  const calls: Record<string, string>[] = [];
  const request: Scheduler['request'] = async (params, explicit, decode, retest, demand, matching) => {
    expect(explicit).toBe(false);
    expect(retest).toBe(false);
    expect(matching).toBe(true);
    if (!demand?.()) throw new DeferredError('busy', 'The tile left the viewport.');
    calls.push(params);
    return decode(await upstream(params));
  };
  const scheduler = { request };
  return { ratings: new HotstarPosterRatings(repo, scheduler, config), repo, calls, config, scheduler };
}

describe('provisional Hotstar poster ratings', () => {
  it('requires one exact movie candidate, rechecks the ID detail, and deduplicates work across tabs and restarts', async () => {
    const { ratings, repo, calls, config, scheduler } = fixture(params =>
      params.s ? search([candidate('tt1234567', 'The Matrix Legacy'), candidate()]) : detail());
    const [a, b] = await Promise.all([ratings.lookup(poster(), active), ratings.lookup(poster(), active)]);
    expect(a).toEqual(b);
    expect(a.record).toMatchObject({ title: 'The Matrix', score: 8.7, subject: { id: 'tt0133093' } });
    expect(a.origin).toBe('fresh');
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(calls).toEqual([{ s: 'The Matrix', type: 'movie', page: '1' }, { i: 'tt0133093', plot: 'short' }]);
    config.settings.mockResolvedValue({ ...DEFAULT_SETTINGS, cacheOnly: true });
    expect(await new HotstarPosterRatings(repo, scheduler, config).lookup(poster(), active)).toEqual({ ...a, origin: 'cache' });
    expect(calls).toHaveLength(2);
    expect(await repo.all('ratings')).toHaveLength(1);
    expect(await repo.all('mappings')).toEqual([]);
    expect(await repo.all('marks')).toEqual([]);
  });

  it('checks the second page for competing identities before rendering and caches a durable miss', async () => {
    const { ratings, calls, repo, config, scheduler } = fixture(params => params.page === '1'
      ? search([candidate(), ...decoys(9)], 11) : search([candidate('tt1234567', 'The Matrix', '2005')], 11));
    const miss = await ratings.lookup(poster(), active);
    expect(miss).toEqual({ record: null, expiresAt: expect.any(Number), outcome: 'ambiguous' });
    expect(calls.map(call => call.page)).toEqual(['1', '2']);
    expect(await new HotstarPosterRatings(repo, scheduler, config).lookup(poster(), active)).toEqual(miss);
    expect(calls).toHaveLength(2);
    expect(await repo.all('ratings')).toEqual([]);
  });

  it('resolves a single exact candidate from a complete two-page set in three calls', async () => {
    const { ratings, calls } = fixture(params => params.page === '1' ? search(decoys(10), 12) :
      params.page === '2' ? search([...decoys(1, 10), candidate()], 12) : detail());
    expect((await ratings.lookup(poster(), active)).record?.score).toBe(8.7);
    expect(calls).toHaveLength(3);
  });

  it.each([3, 4])('resolves the sole exact match after scanning %i complete pages', async pageCount => {
    const total = (pageCount - 1) * 10 + 1;
    const { ratings, calls } = fixture(params => {
      if (!params.page) return detail();
      const page = Number(params.page);
      return search(page === pageCount ? [candidate()] : decoys(10, (page - 1) * 10), total);
    });
    expect(await ratings.lookup(poster(), active)).toMatchObject({ record: { score: 8.7 }, origin: 'fresh' });
    expect(calls.map(call => call.page ?? call.i)).toEqual([
      ...Array.from({ length: pageCount }, (_, index) => String(index + 1)), 'tt0133093',
    ]);
  });

  it('stops after two exact same-type hits even when more pages are available', async () => {
    const { ratings, calls } = fixture(() => search([candidate(), candidate('tt1234567'), ...decoys(8)], 37));
    expect(await ratings.lookup(poster(), active)).toMatchObject({ record: null, outcome: 'ambiguous' });
    expect(calls).toHaveLength(1);
  });

  it('checks raw page counts without treating episodes or games as possible film matches', async () => {
    const episode = candidate('tt1234567', 'Up', '1999', 'episode');
    const game = candidate('tt1234568', 'Up', '1999', 'game');
    const exact = candidate('tt0133093', 'Up');
    const { ratings, calls } = fixture(params => params.page === '1' ? search([episode, ...decoys(9)], 12) :
      params.page === '2' ? search([game, exact], 12) : detail('Up'));
    expect(await ratings.lookup(poster('Up'), active)).toMatchObject({ record: { title: 'Up' }, origin: 'fresh' });
    expect(calls).toHaveLength(3);
    const repeated = fixture(params => params.page === '1' ? search([episode, ...decoys(9)], 12) : search([episode, exact], 12));
    expect(await repeated.ratings.lookup(poster('Up'), active)).toMatchObject({ record: null, outcome: 'retry' });
    expect(repeated.calls).toHaveLength(2);
    expect(await repeated.repo.all('resolutions')).toEqual([]);
  });

  it('refuses more than four pages and rejects changed detail identity', async () => {
    const broad = fixture(() => search([candidate(), ...decoys(9)], 41));
    expect(await broad.ratings.lookup(poster(), active)).toMatchObject({ record: null, outcome: 'too_broad' });
    expect(broad.calls).toHaveLength(1);
    const changed = fixture(params => params.s ? search([candidate()]) : detail('The Matrix', '2005'));
    expect(await changed.ratings.lookup(poster(), active)).toMatchObject({ record: null, outcome: 'conflict' });
    expect(await changed.repo.all('ratings')).toEqual([]);
  });

  it('treats inconsistent pagination and upstream cooldowns as retryable, without persisting a miss', async () => {
    const { ratings, repo } = fixture(params => params.page === '1' ? search(decoys(10), 12) : search([candidate()], 12));
    expect(await ratings.lookup(poster(), active)).toMatchObject({ record: null, retryable: true });
    expect(await repo.all('resolutions')).toEqual([]);
    const retryAt = Date.now() + 100_000;
    const cooldown = fixture(() => { throw new DeferredError('quota', 'Synthetic pause.', retryAt); });
    expect(await cooldown.ratings.lookup(poster(), active)).toEqual({ record: null, retryable: true, expiresAt: retryAt, outcome: 'paused' });
    expect(await cooldown.repo.all('resolutions')).toEqual([]);
  });

  it('caches true no-result responses but preserves demand and settings before making requests', async () => {
    const { ratings, repo, calls, config } = fixture(() => { throw new ProviderError('not_found', 'No matches.'); });
    expect(await ratings.lookup(poster(), () => false)).toMatchObject({ retryable: true });
    config.settings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, automaticMatching: false });
    expect(await ratings.lookup(poster(), active)).toMatchObject({ retryable: true });
    expect(calls).toEqual([]);
    expect(await repo.all('resolutions')).toEqual([]);
    expect(await ratings.lookup(poster(), active)).toEqual({ record: null, expiresAt: expect.any(Number), outcome: 'not_found' });
    expect(await repo.all('resolutions')).toHaveLength(1);
  });

  it('retries legacy misses, preserves legacy matches, and distinguishes fresh searches from cached ratings', async () => {
    const { ratings, repo, calls } = fixture();
    const legacyKey = JSON.stringify(['hotstar-poster-rating', 1, poster().key]);
    const expiresAt = Date.now() + 60000;
    await repo.put('resolutions', legacyKey, { candidate: null, expiresAt });
    const record = parseDetail(detail(), 'tt0133093', Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    expect(await ratings.lookup(poster(), active)).toMatchObject({ record, origin: 'cache' });
    expect(calls).toEqual([{ s: 'The Matrix', type: 'movie', page: '1' }]);

    const legacy = fixture();
    await legacy.repo.put('resolutions', legacyKey, { candidate: { id: record.subject.id, year: record.year }, expiresAt });
    await legacy.repo.put('ratings', ratingKey(record.subject), record);
    expect(await legacy.ratings.lookup(poster(), active)).toEqual({ record, expiresAt, origin: 'cache' });
    expect(legacy.calls).toEqual([]);

    await legacy.repo.put('ratings', ratingKey(record.subject), { ...record, fetchedAt: Date.now() - 365 * 86400000 });
    expect(await legacy.ratings.lookup(poster(), active)).toMatchObject({ record: { score: 8.7 }, origin: 'fresh' });
    expect(legacy.calls).toEqual([{ i: 'tt0133093', plot: 'short' }]);
  });

  it('records a distinct unrated outcome for a title with no provider score', async () => {
    const { ratings, calls } = fixture(params => params.s ? search([candidate()]) : detail('The Matrix', '1999', 'N/A'));
    expect(await ratings.lookup(poster(), active)).toMatchObject({ record: null, outcome: 'unrated' });
    expect(await ratings.lookup(poster(), active)).toMatchObject({ record: null, outcome: 'unrated' });
    expect(calls).toHaveLength(2);
  });

  it('leaves an explicitly cleared rating cache empty when a pre-clear detail reply arrives', async () => {
    let resolveDetail!: (value: ReturnType<typeof detail>) => void;
    const deferred = new Promise<ReturnType<typeof detail>>(resolve => { resolveDetail = resolve; });
    const { ratings, calls, repo } = fixture(params => params.s ? search([candidate()]) : deferred);
    const pending = ratings.lookup(poster(), active);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await clearRatingCache(repo);
    resolveDetail(detail());
    expect(await pending).toMatchObject({ record: null, retryable: true });
    expect(await repo.all('ratings')).toEqual([]);
    expect(await repo.all('resolutions')).toEqual([]);
  });

  it.each([['The Matrix', true], ['Mr. Robot', true], ['Nobody', true], ['Kill', true], ['घर', true], ['12', false], ['...', false]])
    ('requires a letter without imposing a title length minimum for %s', (title, eligible) => expect(eligibleHotstarPosterTitle(title)).toBe(eligible));
});

describe('Hotstar poster rating RPC scope', () => {
  const request = (type: string, args: object) => validateRequest({ protocol: PROTOCOL_VERSION, type, ...args });
  const sender = (url: string, frameId = 0): chrome.runtime.MessageSender =>
    ({ id: 'ext', url, frameId, documentId: 'fixture', tab: { id: 5, incognito: false } as chrome.tabs.Tab });

  it('permits only top-frame Hotstar catalogue content and validates title, artwork, and type binding', () => {
    const action = request('LOOKUP_HOTSTAR_POSTER_RATING', { poster: poster() });
    expect(authoriseRequest(sender('https://www.hotstar.com/in/home'), 'ext', action)).toEqual({ role: 'content', platformId: 'hotstar' });
    expect(() => authoriseRequest(sender('https://www.netflix.com/browse'), 'ext', action)).toThrow(/cannot access/);
    expect(() => authoriseRequest(sender('https://www.hotstar.com/in/movies/fixture/123/watch'), 'ext', action)).toThrow(/not authorised/);
    expect(() => authoriseRequest(sender('https://www.hotstar.com/in/home', 1), 'ext', action)).toThrow(/not authorised/);
    expect(() => request('LOOKUP_HOTSTAR_POSTER_RATING', { poster: { ...poster(), title: 'Different title' } })).toThrow(/Invalid Hotstar poster/);
    expect(() => request('LOOKUP_HOTSTAR_POSTER_RATING', { poster: { ...poster(), mediaType: 'series' } })).toThrow(/Invalid Hotstar poster/);
    expect(() => request('LOOKUP_HOTSTAR_POSTER_RATING', { poster: { ...poster(), key: 'unbound' } })).toThrow(/Invalid Hotstar poster/);
  });

  it('supports targeted demand release while preserving all-document cleanup', () => {
    const action = request('RELEASE_DEMAND', { posterKey: poster().key });
    expect(authoriseRequest(sender('https://www.hotstar.com/in/movies/fixture/123/watch'), 'ext', action)).toMatchObject({ role: 'content' });
    expect(() => authoriseRequest(sender('https://www.netflix.com/browse'), 'ext', action)).toThrow(/cannot access/);
    expect(() => request('RELEASE_DEMAND', { posterKey: poster().key, ref: { platformId: 'hotstar', titleId: '123' } })).toThrow(/Invalid Hotstar poster demand/);
    expect(request('RELEASE_DEMAND', {})).toMatchObject({ type: 'RELEASE_DEMAND' });
  });
});
