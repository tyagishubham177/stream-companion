import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Resolver } from '../../src/background/resolver';
import { Repository } from '../../src/background/repository';
import { DEFAULT_SETTINGS, RESOLVER_VERSION, ratingKey, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import { parseNetflixMetadata, NetflixMetadataResolver, type NetflixMetadataResult } from '../../src/providers/netflix-metadata';
import { parseDetail } from '../../src/providers/omdb';
import { corroboratesSeriesCast, plainTranslationAlias } from '../../src/shared/edition';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';

// Synthetic cases mirror failure shapes seen in local corrections; no user log/title history is included.
const ref = { platformId: 'netflix', titleId: '99101' };
const observation: TitleObservation = { ref, displayTitle: 'Fixture Drama', mediaType: 'unknown', adapterVersion: 3 };
const credits = { directors: ['Fixture Director'], actors: ['Actor One', 'Actor Two', 'Actor Three'] };
const candidate = (id = 'tt9995101', title = 'Fixture Drama', type = 'series', year = '2023–') => ({ imdbID: id, Title: title, Type: type, Year: year });
const detail = (id = 'tt9995101', extra = {}) => ({ Response: 'True', ...candidate(id), imdbRating: '7.5', imdbVotes: '1,000',
  Director: 'N/A', Actors: credits.actors.join(', '), ...extra });
const series = (): NetflixMetadataResult => ({ kind: 'matched', mediaType: 'series', title: 'Fixture Drama', credits: { ...credits, directors: [] }, checkedAt: Date.now() });
const movie = (): NetflixMetadataResult => ({ kind: 'matched', mediaType: 'movie', title: 'Fixture Film', year: 2025, credits, checkedAt: Date.now() });
const search = (...items: ReturnType<typeof candidate>[]) => ({ Response: 'True', totalResults: String(items.length), Search: items });
let repo: Repository;
beforeEach(() => { repo = new Repository(`correction-informed-${crypto.randomUUID()}`); });
afterEach(async () => { (await repo.open()).close(); vi.restoreAllMocks(); });
function setup(source = series()) {
  const resolve = vi.fn(async (): Promise<NetflixMetadataResult> => source);
  const request = vi.fn(async (params: Record<string, string>, _explicit: boolean, decode: (raw: unknown) => unknown) => decode(params.s ? search(candidate()) : detail(params.i)));
  const config = { settings: async () => DEFAULT_SETTINGS, credential: async () => ({ key: 'fixture-only', id: 'fixture-only', version: 1 }) } as unknown as Configuration;
  return { resolver: new Resolver(repo, { request } as unknown as Scheduler, config, { resolve: async () => ({ kind: 'missing' }) }, { resolve }), request, resolve, config };
}
function publicPage(actors = credits.actors, extra = {}) {
  return `<script type="application/ld+json">${JSON.stringify({ '@type': 'TVSeries', name: 'Fixture Drama', url: 'https://www.netflix.com/in/title/99101', dateCreated: '2026-01-01',
    directors: [], actors: actors.map(name => ({ '@type': 'Person', name })), ...extra })}</script><div data-uia="metadata"><h2>Fixture Drama</h2><ul><li>2026</li><li>Season 4</li></ul></div>`;
}

describe('series public evidence without invented start years', () => {
  it('extracts canonical series cast while ignoring season/catalogue dates', () => {
    expect(parseNetflixMetadata(publicPage(), ref.titleId)).toMatchObject({ kind: 'matched', mediaType: 'series', title: 'Fixture Drama', credits: { directors: [], actors: credits.actors } });
    expect(parseNetflixMetadata(publicPage(), ref.titleId)).not.toHaveProperty('year');
  });
  it.each([[], ['Actor One', 'Actor Two'], ['Actor One', 'Actor One', 'Actor One']].map(actors => ({ actors })))('keeps inadequate/duplicate cast missing %#', ({ actors }) => {
    expect(parseNetflixMetadata(publicPage(actors), ref.titleId)).toEqual({ kind: 'missing' });
  });
  it('requires the visible title header and the exact canonical-bound identity', () => {
    expect(() => parseNetflixMetadata(publicPage().replace('<h2>Fixture Drama</h2>', '<h2>Wrong</h2>'), ref.titleId)).toThrow();
    expect(() => parseNetflixMetadata(publicPage(undefined, { url: 'https://www.netflix.com/title/123' }), ref.titleId)).toThrow();
  });
  it('preserves usable series actors when OMDb has no director, without loosening movie credits', () => {
    expect(parseDetail(detail(), 'tt9995101', 100).credits).toEqual({ directors: [], actors: credits.actors });
    expect(parseDetail(detail(undefined, { Type: 'movie', Year: '2023' }), 'tt9995101', 100).credits).toBeUndefined();
  });
  it('upgrades a legacy cached unsupported-series miss once', async () => {
    const key = JSON.stringify(['netflix-metadata', 'netflix', ref.titleId]);
    await repo.put('resolutions', key, { expiresAt: Date.now() + 86400000, result: { kind: 'missing' }, creditsChecked: true });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(publicPage(), { headers: { 'Content-Type': 'text/html' } }));
    const provider = new NetflixMetadataResolver(repo, async () => ({ enabled: true, cacheOnly: false }), fetcher);
    expect((await provider.resolve(ref, () => true)).kind).toBe('matched');
    expect((await provider.resolve(ref, () => true)).kind).toBe('matched');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires three distinct cast matches, not repeated copies of one actor', () => {
    expect(corroboratesSeriesCast(credits, { directors: [], actors: ['Actor One', 'Actor One', 'Actor One'] })).toBe(false);
    expect(corroboratesSeriesCast(credits, { directors: [], actors: [...credits.actors].reverse() })).toBe(true);
  });
});

describe('corroborated series resolution', () => {
  it('keeps a known rating usable without revalidating an aged source when automatic matching is off', async () => {
    const record = parseDetail(detail(), 'tt9995101', Date.now());
    await repo.put('mappings', titleKey(ref), { ref, evidence: { ...observation, mediaType: 'series' },
      subject: record.subject, revision: 1, rejected: [], method: 'automatic', resolverVersion: RESOLVER_VERSION,
      provenance: { source: 'netflix', checkedAt: Date.now() - 40 * 86400000, matchBasis: 'credits' } } satisfies Mapping);
    await repo.put('ratings', ratingKey(record.subject), record);
    const { resolver, request, resolve, config } = setup();
    vi.spyOn(config, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, automaticMatching: false });
    expect((await resolver.lookup(observation)).state.kind).toBe('rated');
    expect(resolve).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('keeps operational misses without collecting diagnostic search history when logging is disabled', async () => {
    const { resolver, request, config } = setup();
    vi.spyOn(config, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, matchingLogEnabled: false });
    request.mockImplementation(async (_params, _explicit, decode) => decode(search()));
    expect((await resolver.lookup(observation)).state.kind).toBe('needs_match');
    const resolutions = await repo.all<{ state?: unknown; trace?: unknown; traceEpoch?: number }>('resolutions');
    expect(resolutions.some(entry => entry.value.state)).toBe(true);
    for (const entry of resolutions) { expect(entry.value.trace).toBeUndefined(); expect(entry.value.traceEpoch).toBeUndefined(); }
  });
  it('uses exact series title/type plus three actors, with no season-year search filter', async () => {
    const { resolver, request } = setup();
    expect((await resolver.lookup(observation)).state).toMatchObject({ kind: 'rated', matchBasis: 'credits', record: { subject: { id: 'tt9995101' } } });
    expect(request.mock.calls.map(call => call[0])).toEqual([{ s: 'Fixture Drama', type: 'series', page: '1' }, { i: 'tt9995101', plot: 'short' }]);
    expect((await repo.get<Mapping>('mappings', titleKey(ref)))?.evidence.year).toBeUndefined();
  });
  it.each([{ Actors: 'Actor One, Actor Two, Different' }, { Title: 'Fixture Drama II' }, { Type: 'movie', Year: '2023' }])('rejects detail contradictions %j', async mismatch => {
    const { resolver, request } = setup(); request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search(candidate()) : detail(undefined, mismatch)));
    expect((await resolver.lookup(observation)).state.kind).toBe('needs_match');
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
  });
  it('disambiguates two exact-name series only when one detail has the corroborated cast', async () => {
    const { resolver, request } = setup(); request.mockImplementation(async (params, _explicit, decode) => decode(params.s
      ? search(candidate(), candidate('tt9995102')) : detail(params.i, params.i === 'tt9995102' ? { Actors: 'Other One, Other Two, Other Three' } : {})));
    expect((await resolver.lookup(observation)).state).toMatchObject({ kind: 'rated', record: { subject: { id: 'tt9995101' } } });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('keeps equal corroborated series ambiguous and does not choose rank one', async () => {
    const { resolver, request } = setup(); request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search(candidate(), candidate('tt9995102')) : detail(params.i)));
    expect((await resolver.lookup(observation)).state).toMatchObject({ kind: 'needs_match', reason: 'ambiguous' });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('does not fetch details when three candidates or an incomplete search prevents bounded uniqueness', async () => {
    const { resolver, request } = setup(); request.mockImplementation(async (_params, _explicit, decode) => decode(search(candidate(), candidate('tt9995102'), candidate('tt9995103'))));
    expect((await resolver.lookup(observation)).state).toMatchObject({ kind: 'needs_match', reason: 'ambiguous' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('movie evidence for ambiguity and translated provider titles', () => {
  const filmCandidate = (id = 'tt9995201') => candidate(id, 'Fixture Film', 'movie', '2025');
  const filmDetail = (id = 'tt9995201', extra = {}) => detail(id, { ...filmCandidate(id), Director: credits.directors.join(', '), ...extra });
  it('selects the unique director/two-actor corroborated movie from two exact eligible IDs', async () => {
    const { resolver, request } = setup(movie()); request.mockImplementation(async (params, _explicit, decode) => decode(params.s
      ? search(filmCandidate(), filmCandidate('tt9995202')) : filmDetail(params.i, params.i === 'tt9995202' ? { Director: 'Wrong Director' } : {})));
    expect((await resolver.lookup({ ...observation, displayTitle: 'Fixture Film' })).state).toMatchObject({ kind: 'rated', record: { subject: { id: 'tt9995201' } } });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('retains ambiguity when both movie details corroborate', async () => {
    const { resolver, request } = setup(movie()); request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search(filmCandidate(), filmCandidate('tt9995202')) : filmDetail(params.i)));
    expect((await resolver.lookup({ ...observation, displayTitle: 'Fixture Film' })).state).toMatchObject({ kind: 'needs_match', reason: 'ambiguous' });
  });
  it('uses a bounded title-detail query after a complete search miss, requiring exact year and director/two actors', async () => {
    const { resolver, request } = setup(movie()); request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search() : filmDetail(undefined, { Title: 'Fixture Translated Name' })));
    expect((await resolver.lookup({ ...observation, displayTitle: 'Fixture Film' })).state).toMatchObject({ kind: 'rated', record: { title: 'Fixture Translated Name' }, matchBasis: 'credits' });
    expect(request.mock.calls.map(call => call[0])).toEqual([{ s: 'Fixture Film', y: '2025', type: 'movie', page: '1' }, { t: 'Fixture Film', y: '2025', type: 'movie', plot: 'short' }]);
    expect((await repo.get<Mapping>('mappings', titleKey(ref)))?.resolverVersion).toBe(RESOLVER_VERSION);
  });
  it.each([{ Year: '2024' }, { Director: 'Wrong' }, { Actors: 'Actor One, Wrong, Different' }, { Title: 'Fixture Film II' }, { Type: 'series' }])('rejects a title-query response with %j', async mismatch => {
    const { resolver, request } = setup(movie()); request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search() : filmDetail(undefined, mismatch)));
    expect((await resolver.lookup({ ...observation, displayTitle: 'Fixture Film' })).state.kind).toBe('needs_match');
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
  });
  it('does not overwrite a manual correction made during title-detail fallback', async () => {
    const { resolver, request } = setup(movie()); request.mockImplementation(async (params, _explicit, decode) => {
      if (params.t) await repo.put('mappings', titleKey(ref), { ref, evidence: observation, revision: 1, method: 'manual', rejected: [], resolverVersion: RESOLVER_VERSION,
        subject: { namespace: 'imdb', id: 'tt9995299' } } satisfies Mapping);
      return decode(params.s ? search() : filmDetail(undefined, { Title: 'Fixture Translated Name' }));
    });
    expect((await resolver.lookup({ ...observation, displayTitle: 'Fixture Film' })).state.kind).toBe('needs_match');
    expect((await repo.get<Mapping>('mappings', titleKey(ref)))?.subject?.id).toBe('tt9995299');
  });
  it.each(['Film II', 'Film 2', 'Film (Part Two)', 'Film: A Story'])('does not lose meaningful sequel/subtitle identity in a translated detail: %s', title => {
    expect(plainTranslationAlias(title, 'Other Film')).toBe(false);
    expect(plainTranslationAlias('Other Film', title)).toBe(false);
  });
});
