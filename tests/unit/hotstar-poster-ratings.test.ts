import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { clearRatingCache, HotstarPosterRatings } from '../../src/background/hotstar-poster-ratings';
import { Repository } from '../../src/background/repository';
import { DeferredError, type Scheduler } from '../../src/background/scheduler';
import { ProviderError } from '../../src/providers/omdb';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, type HotstarPosterRatingRequest } from '../../src/shared/contracts';
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
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(calls).toEqual([{ s: 'The Matrix', type: 'movie', page: '1' }, { i: 'tt0133093', plot: 'short' }]);
    config.settings.mockResolvedValue({ ...DEFAULT_SETTINGS, cacheOnly: true });
    expect(await new HotstarPosterRatings(repo, scheduler, config).lookup(poster(), active)).toEqual(a);
    expect(calls).toHaveLength(2);
    expect(await repo.all('ratings')).toHaveLength(1);
    expect(await repo.all('mappings')).toEqual([]);
    expect(await repo.all('marks')).toEqual([]);
  });

  it('checks the second page for competing identities before rendering and caches a durable miss', async () => {
    const { ratings, calls, repo, config, scheduler } = fixture(params => params.page === '1'
      ? search([candidate(), ...decoys(9)], 11) : search([candidate('tt1234567', 'The Matrix', '2005')], 11));
    const miss = await ratings.lookup(poster(), active);
    expect(miss).toEqual({ record: null, expiresAt: expect.any(Number) });
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

  it('refuses more than two pages and rejects changed detail identity', async () => {
    const broad = fixture(() => search([candidate(), ...decoys(9)], 21));
    expect((await broad.ratings.lookup(poster(), active)).record).toBeNull();
    expect(broad.calls).toHaveLength(1);
    const changed = fixture(params => params.s ? search([candidate()]) : detail('The Matrix', '2005'));
    expect((await changed.ratings.lookup(poster(), active)).record).toBeNull();
    expect(await changed.repo.all('ratings')).toEqual([]);
  });

  it('treats inconsistent pagination and upstream cooldowns as retryable, without persisting a miss', async () => {
    const { ratings, repo } = fixture(params => params.page === '1' ? search(decoys(10), 12) : search([candidate()], 12));
    expect(await ratings.lookup(poster(), active)).toMatchObject({ record: null, retryable: true });
    expect(await repo.all('resolutions')).toEqual([]);
    const retryAt = Date.now() + 100_000;
    const cooldown = fixture(() => { throw new DeferredError('quota', 'Synthetic pause.', retryAt); });
    expect(await cooldown.ratings.lookup(poster(), active)).toEqual({ record: null, retryable: true, expiresAt: retryAt });
    expect(await cooldown.repo.all('resolutions')).toEqual([]);
  });

  it('caches true no-result responses but preserves demand and settings before making requests', async () => {
    const { ratings, repo, calls, config } = fixture(() => { throw new ProviderError('not_found', 'No matches.'); });
    expect(await ratings.lookup(poster(), () => false)).toMatchObject({ retryable: true });
    config.settings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, automaticMatching: false });
    expect(await ratings.lookup(poster(), active)).toMatchObject({ retryable: true });
    expect(calls).toEqual([]);
    expect(await repo.all('resolutions')).toEqual([]);
    expect(await ratings.lookup(poster(), active)).toEqual({ record: null, expiresAt: expect.any(Number) });
    expect(await repo.all('resolutions')).toHaveLength(1);
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

  it.each([['The Matrix', true], ['Mr. Robot', false], ['BlackBerry', true], ['Nobody', false], ['Kill', false], ['Burn After Reading', true]])
    ('uses a conservative minimum for %s', (title, eligible) => expect(eligibleHotstarPosterTitle(title)).toBe(eligible));
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
