import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, ratingKey, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import { observationFingerprint } from '../../src/shared/identity';
import { Resolver } from '../../src/background/resolver';
import { Repository } from '../../src/background/repository';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';
import { parseDetail } from '../../src/providers/omdb';
import type { DirectIdResult } from '../../src/providers/wikidata';
import type { NetflixMetadataResult } from '../../src/providers/netflix-metadata';

// Scores and IMDb IDs below are synthetic fixtures, not assertions about these films' live ratings.
const films = [
  { title: 'English Vinglish', year: 2012, id: 'tt9991001', sourceId: '1001' },
  { title: 'Gully Boy', year: 2019, id: 'tt9991002', sourceId: '1002' },
  { title: 'Baar Baar Dekho', year: 2016, id: 'tt9991003', sourceId: '1003' },
];
type Film = typeof films[number];
const observation = (film = films[0]): TitleObservation => ({ ref: { platformId: 'netflix', titleId: film.sourceId }, displayTitle: film.title, mediaType: 'unknown', adapterVersion: 1 });
const metadata = (film = films[0]): NetflixMetadataResult => ({ kind: 'matched', title: film.title, mediaType: 'movie', year: film.year, checkedAt: Date.now() });
const detail = (film = films[0]) => ({ Response: 'True', Title: film.title, Year: String(film.year), Type: 'movie', imdbID: film.id, imdbRating: '7.5', imdbVotes: '1,234' });
const candidate = (film = films[0]) => ({ Title: film.title, Year: String(film.year), Type: 'movie', imdbID: film.id });
const search = (film = films[0]) => ({ Response: 'True', totalResults: '1', Search: [candidate(film)] });
let repo: Repository;
beforeEach(() => { repo = new Repository(`metadata-resolution-${crypto.randomUUID()}`); });

function setup(film = films[0], source: NetflixMetadataResult = metadata(film), direct: DirectIdResult = { kind: 'missing' }) {
  const resolveMetadata = vi.fn(async (): Promise<NetflixMetadataResult> => source);
  const resolveDirect = vi.fn(async (): Promise<DirectIdResult> => direct);
  const request = vi.fn(async (params: Record<string, string>, _explicit: boolean, decode: (raw: unknown) => unknown) => decode(params.s ? search(film) : detail(film)));
  const config = {
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    credential: async () => ({ key: 'synthetic-key', id: 'synthetic-credential', version: 1 }),
  } as unknown as Configuration;
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, { resolve: resolveDirect }, { resolve: resolveMetadata });
  return { resolver, resolveMetadata, resolveDirect, request, config };
}
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}
function saved(film = films[0], method: Mapping['method'] = 'automatic'): Mapping {
  return { ref: observation(film).ref, subject: { namespace: 'imdb', id: film.id },
    evidence: { ...observation(film), mediaType: 'movie', year: { value: film.year, meaning: 'movie_release' }, aliases: [film.title] },
    method, revision: 1, rejected: [], resolverVersion: 3,
    provenance: { source: 'netflix', checkedAt: Date.now() - 31 * 86400000 } };
}

describe('public Netflix movie metadata fallback', () => {
  it.each(films)('automatically resolves $title with its public movie year before requesting its score', async film => {
    const { resolver, resolveMetadata, request } = setup(film);
    expect(await resolver.lookup(observation(film))).toMatchObject({ revision: 1, state: { kind: 'rated', identitySource: 'netflix', record: { subject: { id: film.id }, score: 7.5 } } });
    expect(resolveMetadata).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(call => call[0])).toEqual([
      { s: film.title, y: String(film.year), type: 'movie', page: '1' },
      { i: film.id, plot: 'short' },
    ]);
    const mapping = await repo.get<Mapping>('mappings', titleKey(observation(film).ref));
    expect(mapping?.evidence).toMatchObject({ mediaType: 'movie', year: { value: film.year, meaning: 'movie_release' } });
    expect(mapping?.provenance?.source).toBe('netflix');
  });

  it('uses the canonical public title as an evidence-backed alias for a localized card', async () => {
    const { resolver, request } = setup();
    expect((await resolver.lookup({ ...observation(), displayTitle: 'इंग्लिश विंग्लिश' })).state).toMatchObject({ kind: 'rated', record: { title: films[0].title } });
    expect(request.mock.calls[0][0].s).toBe(films[0].title);
    const mapping = await repo.get<Mapping>('mappings', titleKey(observation().ref));
    expect([mapping?.evidence.displayTitle, ...(mapping?.evidence.aliases ?? [])]).toContain(films[0].title);
  });

  it('selects the exact release year rather than the first same-name remake', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? {
      Response: 'True', totalResults: '2', Search: [candidate({ ...films[0], year: 2018, id: 'tt9992001' }), candidate()],
    } : detail()));
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'rated', record: { subject: { id: films[0].id }, year: '2012' } });
    expect(request.mock.calls[1][0].i).toBe(films[0].id);
  });

  it('leaves equal same-name same-year candidates unresolved instead of choosing by rank', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (_params, _explicit, decode) => decode({
      Response: 'True', totalResults: '2', Search: [candidate(), candidate({ ...films[0], id: 'tt9992001' })],
    }));
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'needs_match', reason: 'ambiguous' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await repo.get('mappings', titleKey(observation().ref))).toBeUndefined();
  });

  it('does not establish uniqueness from a truncated provider result set', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (_params, _explicit, decode) => decode({ ...search(), totalResults: '11' }));
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'needs_match', reason: 'ambiguous' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await repo.get('mappings', titleKey(observation().ref))).toBeUndefined();
  });

  it.each([
    { Year: '2013' }, { Type: 'series' }, { Title: 'Another work' }, { imdbID: 'tt9992001' },
  ])('rejects a selected candidate whose detail response contradicts %j', async mismatch => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search() : { ...detail(), ...mismatch }));
    expect((await resolver.lookup(observation())).state.kind).not.toBe('rated');
    expect(await repo.get('mappings', titleKey(observation().ref))).toBeUndefined();
  });

  it('preserves a rejected candidate for the source title', async () => {
    const tombstone: Mapping = { ...saved(), subject: undefined, rejected: [films[0].id], provenance: undefined };
    await repo.put('mappings', titleKey(observation().ref), tombstone);
    const { resolver, request } = setup();
    expect((await resolver.lookup(observation())).state.kind).toBe('needs_match');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await repo.get<Mapping>('mappings', titleKey(observation().ref)))?.subject).toBeUndefined();
  });

  it('reuses fresh shared details after validating a complete matching candidate set', async () => {
    const record = parseDetail(detail(), films[0].id, Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    const { resolver, request, resolveMetadata, resolveDirect } = setup();
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'rated', record: { fetchedAt: record.fetchedAt } });
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0]).toHaveProperty('s');
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
    expect(request).toHaveBeenCalledTimes(1); expect(resolveMetadata).toHaveBeenCalledTimes(1); expect(resolveDirect).toHaveBeenCalledTimes(1);
  });

  it('saves the matched identity even when the provider has no usable score', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search() : { ...detail(), imdbRating: 'N/A' }));
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'unrated', identitySource: 'netflix', record: { score: null } });
    expect((await repo.get<Mapping>('mappings', titleKey(observation().ref)))?.subject?.id).toBe(films[0].id);
  });

  it.each([
    { kind: 'missing' }, { kind: 'deferred', reason: 'provider', message: 'Try later' },
  ] satisfies NetflixMetadataResult[])('does not invent a rating when initial public metadata is %j', async source => {
    const { resolver, request } = setup(undefined, source);
    expect((await resolver.lookup(observation())).state.kind).not.toBe('rated');
    expect(request).not.toHaveBeenCalled(); expect(await repo.get('mappings', titleKey(observation().ref))).toBeUndefined();
  });

  it('does not let an older query miss suppress newly available movie metadata', async () => {
    await repo.put('resolutions', JSON.stringify([observationFingerprint(observation()), 0, 0, 2]), {
      expiresAt: Date.now() + 86400000, attempts: 3, state: { kind: 'needs_match', reason: 'not_found' },
    });
    const { resolver } = setup();
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
  });

  it('does not overwrite a manual correction made while public metadata is pending', async () => {
    const { resolver, resolveMetadata } = setup(); const gate = deferred<NetflixMetadataResult>();
    resolveMetadata.mockImplementation(() => gate.promise);
    const pending = resolver.lookup(observation());
    await vi.waitFor(() => expect(resolveMetadata).toHaveBeenCalledTimes(1));
    await repo.put('mappings', titleKey(observation().ref), { ...saved(undefined, 'manual'), subject: { namespace: 'imdb', id: 'tt9992001' } });
    gate.release(metadata());
    expect((await pending).state.kind).toBe('needs_match');
    expect((await repo.get<Mapping>('mappings', titleKey(observation().ref)))?.subject?.id).toBe('tt9992001');
  });

  it('cannot recreate an absent mapping after reset while public metadata is pending', async () => {
    const { resolver, resolveMetadata } = setup(); const gate = deferred<NetflixMetadataResult>();
    resolveMetadata.mockImplementation(() => gate.promise);
    const pending = resolver.lookup(observation());
    await vi.waitFor(() => expect(resolveMetadata).toHaveBeenCalledTimes(1));
    await repo.put('state', 'mappingEpoch', 1); gate.release(metadata());
    expect((await pending).state.kind).toBe('needs_match');
    expect(await repo.get('mappings', titleKey(observation().ref))).toBeUndefined();
  });

  it('does not fetch public metadata when an ID relationship already supplies the work', async () => {
    const direct: DirectIdResult = { kind: 'matched', imdbId: films[0].id, entityIds: ['Q1001'], checkedAt: Date.now() };
    const { resolver, resolveMetadata, request } = setup(undefined, metadata(), direct);
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
    expect(resolveMetadata).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ i: films[0].id, plot: 'short' });
  });

  it('does not add a public-page fetch when the observed movie already has sufficient evidence', async () => {
    const { resolver, resolveMetadata } = setup();
    expect((await resolver.lookup({ ...observation(), mediaType: 'movie', year: { value: films[0].year, meaning: 'movie_release' } })).state.kind).toBe('rated');
    expect(resolveMetadata).not.toHaveBeenCalled();
  });

  it('returns the compatible winning match to concurrent canonical and localized observations', async () => {
    const { resolver, resolveMetadata } = setup(); const gate = deferred<NetflixMetadataResult>();
    resolveMetadata.mockImplementation(() => gate.promise);
    const canonical = resolver.lookup(observation());
    const localized = resolver.lookup({ ...observation(), displayTitle: 'इंग्लिश विंग्लिश' });
    await vi.waitFor(() => expect(resolveMetadata).toHaveBeenCalledTimes(2)); gate.release(metadata());
    const results = await Promise.all([canonical, localized]);
    expect(results.every(result => result.state.kind === 'rated')).toBe(true);
    expect(results.map(result => result.revision)).toEqual([1, 1]);
  });

  it.each([
    { kind: 'ambiguous' }, { kind: 'deferred', reason: 'provider', message: 'Try later' },
  ] satisfies DirectIdResult[])('does not use metadata to bypass a %j ID relationship', async direct => {
    const { resolver, resolveMetadata, request } = setup(undefined, metadata(), direct);
    expect((await resolver.lookup(observation())).state.kind).not.toBe('rated');
    expect(resolveMetadata).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'cache-only', 'no-key'] as const)('does not fetch public metadata in %s mode', async mode => {
    const { resolver, resolveMetadata, resolveDirect, request, config } = setup();
    if (mode === 'disabled') vi.spyOn(config, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, enabled: false });
    if (mode === 'cache-only') vi.spyOn(config, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, cacheOnly: true });
    if (mode === 'no-key') vi.spyOn(config, 'credential').mockResolvedValue(undefined);
    expect((await resolver.lookup(observation())).state.kind).not.toBe('rated');
    expect(resolveMetadata).not.toHaveBeenCalled(); expect(resolveDirect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});

describe('public metadata relationship revalidation', () => {
  async function seed(method: Mapping['method'] = 'automatic') {
    const mapping = saved(undefined, method), record = parseDetail(detail(), films[0].id, Date.now());
    await repo.put('mappings', titleKey(observation().ref), mapping); await repo.put('ratings', ratingKey(record.subject), record);
    return record;
  }

  it('renews expired canonical metadata while retaining the fresh rating snapshot', async () => {
    const record = await seed(); const fresh = metadata(); const { resolver, resolveMetadata, request } = setup(undefined, fresh);
    expect(await resolver.lookup(observation())).toMatchObject({ revision: 2, state: { kind: 'rated', identitySource: 'netflix', record: { fetchedAt: record.fetchedAt } } });
    expect(resolveMetadata).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
    expect((await repo.get<Mapping>('mappings', titleKey(observation().ref)))?.provenance?.checkedAt).toBe(fresh.kind === 'matched' ? fresh.checkedAt : undefined);
  });

  it('reruns exact matching when authoritative movie title/year changes', async () => {
    await seed(); const changed: Film = { ...films[0], title: 'Fixture corrected title', year: 2013, id: 'tt9992001' };
    const { resolver, request } = setup(changed, metadata(changed));
    expect(await resolver.lookup(observation())).toMatchObject({ revision: 2, state: { kind: 'rated', record: { subject: { id: changed.id }, title: changed.title, year: '2013' } } });
    expect(request.mock.calls[0][0]).toEqual({ s: changed.title, y: '2013', type: 'movie', page: '1' });
    expect((await repo.get<Mapping>('mappings', titleKey(observation().ref)))?.subject?.id).toBe(changed.id);
  });

  it('does not bypass changed authoritative metadata with stale strong card evidence', async () => {
    await seed(); const changed: Film = { ...films[0], year: 2019, id: 'tt9992001' };
    const { resolver, resolveMetadata, request } = setup(changed, metadata(changed));
    expect(await resolver.lookup({ ...observation(), mediaType: 'movie', year: { value: 2012, meaning: 'movie_release' } })).toMatchObject({
      revision: 1, state: { kind: 'needs_match', reason: 'contradiction' },
    });
    expect(resolveMetadata).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
    expect((await repo.get<Mapping>('mappings', titleKey(observation().ref)))?.subject?.id).toBe(films[0].id);
  });

  it.each([
    { kind: 'missing' }, { kind: 'deferred', reason: 'provider', message: 'Try later' },
  ] satisfies NetflixMetadataResult[])('retains a compatible known cached rating when metadata is %j', async source => {
    const record = await seed(); const { resolver, resolveMetadata, request } = setup(undefined, source);
    expect(await resolver.lookup(observation())).toMatchObject({ revision: 1, state: { kind: 'rated', record: { fetchedAt: record.fetchedAt } } });
    expect(resolveMetadata).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
  });

  it('does not source-revalidate a manual choice', async () => {
    await seed('manual'); const { resolver, resolveMetadata, resolveDirect, request } = setup();
    expect(await resolver.lookup(observation())).toMatchObject({ revision: 1, state: { kind: 'rated', method: 'manual' } });
    expect(resolveMetadata).not.toHaveBeenCalled(); expect(resolveDirect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it('keeps explicit Refresh as a rating-only request', async () => {
    await seed(); const { resolver, resolveMetadata, request } = setup();
    expect(await resolver.lookup(observation(), true, 1)).toMatchObject({ revision: 1, state: { kind: 'rated' } });
    expect(resolveMetadata).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ i: films[0].id, plot: 'short' }); expect(request.mock.calls[0][1]).toBe(true);
  });

  it('uses an expired-source mapping in cache-only mode without revalidating it', async () => {
    await seed(); const { resolver, config, resolveMetadata, resolveDirect, request } = setup();
    vi.spyOn(config, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, cacheOnly: true });
    expect(await resolver.lookup(observation())).toMatchObject({ revision: 1, state: { kind: 'rated' } });
    expect(resolveMetadata).not.toHaveBeenCalled(); expect(resolveDirect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});
