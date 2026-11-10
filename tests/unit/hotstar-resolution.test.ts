import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, ratingKey, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import { Repository } from '../../src/background/repository';
import { Resolver } from '../../src/background/resolver';
import { parseDetail } from '../../src/providers/omdb';
import type { DirectIdResult } from '../../src/providers/wikidata';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';

const series: TitleObservation = {
  ref: { platformId: 'hotstar', titleId: '8549' }, displayTitle: 'Fixture Family', mediaType: 'series',
  pagePath: '/in/shows/fixture-family/8549', adapterVersion: 1,
};
const cast = { directors: [], actors: ['Alice Fixture', 'Ben Fixture', 'Carla Fixture'] };

function fixture(type: 'series' | 'movie', actors: string, title: string, year: string) {
  const repo = new Repository(`hotstar-resolver-${crypto.randomUUID()}`);
  const config = { settings: async () => DEFAULT_SETTINGS, credential: async () => ({ key: 'fixture_only' }) } as unknown as Configuration;
  const request = vi.fn(async (params: Record<string, string>, _explicit: boolean, decode: (raw: unknown) => unknown) => {
    return decode(params.s ? { Response: 'True', totalResults: '1', Search: [{ Title: title, Year: year, Type: type, imdbID: 'tt1234567' }] }
      : { Response: 'True', Title: title, Year: year, Type: type, imdbID: 'tt1234567', imdbRating: '8.1', imdbVotes: '123', Director: 'N/A', Actors: actors });
  });
  const fetchNetflixMetadata = vi.fn(async () => ({ kind: 'missing' as const }));
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config,
    { resolve: async () => ({ kind: 'missing' }) }, { resolve: fetchNetflixMetadata });
  return { repo, resolver, request, fetchNetflixMetadata };
}

it('uses public Hotstar cast from the detail page without guessing a series start year', async () => {
  const { resolver, repo, request, fetchNetflixMetadata } = fixture('series', cast.actors.join(', '), series.displayTitle, '2009–2020');
  const initial = await resolver.lookup(series);
  expect(initial.state.kind).toBe('needs_match');
  expect(request).not.toHaveBeenCalled();
  const resolved = await resolver.lookup({ ...series, credits: cast });
  expect(resolved.state).toMatchObject({ kind: 'rated', identitySource: 'hotstar', matchBasis: 'credits', record: { score: 8.1 } });
  expect(request.mock.calls[0][0]).toEqual({ s: series.displayTitle, type: 'series', page: '1' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(fetchNetflixMetadata).not.toHaveBeenCalled();
  expect((await repo.get<Mapping>('mappings', titleKey(series.ref)))?.provenance).toMatchObject({ source: 'hotstar' });
  expect((await resolver.lookup(series)).state.kind).toBe('rated');
  expect(request).toHaveBeenCalledTimes(2);
});

it('rejects an exact series title whose cast does not corroborate the Hotstar work', async () => {
  const { resolver, repo } = fixture('series', 'Alice Fixture, Ben Fixture, Different Fixture', series.displayTitle, '2009–2020');
  expect((await resolver.lookup({ ...series, credits: cast })).state).toEqual({ kind: 'needs_match', reason: 'contradiction' });
  expect(await repo.get('mappings', titleKey(series.ref))).toBeUndefined();
});

it('uses exact film title, year and type without sending Hotstar page paths to OMDb', async () => {
  const { resolver, request, fetchNetflixMetadata } = fixture('movie', 'Alice Fixture', 'Fixture Film', '2013');
  const film: TitleObservation = { ...series, mediaType: 'movie', displayTitle: 'Fixture Film', pagePath: '/in/movies/fixture-film/8549',
    year: { value: 2013, meaning: 'movie_release' } };
  expect((await resolver.lookup(film)).state.kind).toBe('rated');
  expect(request.mock.calls[0][0]).toEqual({ s: 'Fixture Film', type: 'movie', y: '2013', page: '1' });
  expect(fetchNetflixMetadata).not.toHaveBeenCalled();
});

const yearObservation: TitleObservation = { ...series, year: { value: 2013, meaning: 'season_release' }, seasonCount: 9 };
const workId = 'tt1234567';
const otherId = 'tt1234568';
const searchHit = (imdbID = workId, Year = '2005–2013') => ({ imdbID, Year, Title: series.displayTitle, Type: 'series' });
const details = (extra: Record<string, unknown> = {}) => ({ Response: 'True', ...searchHit(), totalSeasons: '9', imdbRating: '8.1',
  Actors: cast.actors.join(', '), ...extra });

function seasonFixture(hits = [searchHit()], records: Record<string, unknown> = { [workId]: details() }, total = hits.length,
  direct: DirectIdResult = { kind: 'missing' }) {
  const repo = new Repository(`hotstar-seasons-${crypto.randomUUID()}`);
  const config = { settings: async () => DEFAULT_SETTINGS, credential: async () => ({ key: 'fixture_only' }) } as unknown as Configuration;
  const request = vi.fn(async (params: Record<string, string>, _explicit: boolean, decode: (raw: unknown) => unknown) =>
    decode(params.s ? { Response: 'True', totalResults: String(total), Search: hits } : records[params.i]));
  const publicMetadata = vi.fn(async () => ({ kind: 'missing' as const }));
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, { resolve: async () => direct }, { resolve: publicMetadata });
  return { repo, resolver, request, publicMetadata };
}

describe('Hotstar series season corroboration', () => {
  it('uses a matching end year and exact season count, never as the OMDb start-year filter', async () => {
    const { repo, resolver, request, publicMetadata } = seasonFixture([searchHit(otherId, '2001–2003'), searchHit()]);
    const result = await resolver.lookup(yearObservation);
    expect(result.state).toMatchObject({ kind: 'rated', identitySource: 'hotstar', matchBasis: 'seasons', record: { seasonCount: 9, score: 8.1 } });
    expect(request.mock.calls.map(call => call[0])).toEqual([
      { s: series.displayTitle, type: 'series', page: '1' }, { i: workId, plot: 'short' },
    ]);
    expect(publicMetadata).not.toHaveBeenCalled();
    expect(await repo.get<Mapping>('mappings', titleKey(series.ref))).toMatchObject({
      subject: { id: workId }, evidence: { year: { value: 2013, meaning: 'season_release' }, seasonCount: 9 },
      provenance: { source: 'hotstar', matchBasis: 'seasons' },
    });
    expect((await resolver.lookup(series)).state).toMatchObject({ kind: 'rated', identitySource: 'hotstar', matchBasis: 'seasons' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('matches an open-ended range only by its known start and exact count', async () => {
    const { resolver } = seasonFixture([searchHit(workId, '2013–')], { [workId]: details({ Year: '2013–' }) });
    expect((await resolver.lookup(yearObservation)).state).toMatchObject({ kind: 'rated', matchBasis: 'seasons' });
  });

  it.each(['2005–', '2005–2020', '2013–2005', '2013–201', '2013 special'])('does not fetch details for nonmatching or malformed year range %s', async year => {
    const { resolver, request } = seasonFixture([searchHit(workId, year)]);
    expect((await resolver.lookup(yearObservation)).state.kind).toBe('needs_match');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([{ totalSeasons: undefined }, { totalSeasons: '8' }, { Year: '2005–' }, { Year: '2013–2020' }, { Title: 'Another work' }, { Type: 'movie' }])
    ('keeps the title unresolved if IMDb details do not confirm the season evidence %j', async override => {
      const { resolver, repo, request } = seasonFixture([searchHit()], { [workId]: details(override) });
      expect((await resolver.lookup(yearObservation)).state.kind).toBe('needs_match');
      expect(await repo.get('mappings', titleKey(series.ref))).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
    });

  it.each([{ seasonCount: undefined }, { year: undefined }, { year: { value: 2013, meaning: 'unknown' } }] satisfies Partial<TitleObservation>[])
    ('does not search with missing or unusable season evidence %j', async override => {
      const { resolver, request } = seasonFixture();
      expect((await resolver.lookup({ ...yearObservation, ...override })).state.kind).toBe('needs_match');
      expect(request).not.toHaveBeenCalled();
    });

  it.each([
    { ...searchHit(), Title: 'Fixture Family: Different Work' }, { ...searchHit(), Type: 'movie' },
  ])('does not inspect a candidate of another name or type %j', async candidate => {
    const { resolver, request } = seasonFixture([candidate]);
    expect((await resolver.lookup(yearObservation)).state.kind).toBe('needs_match');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('chooses one of two year-matching candidates only when the other has a different season count', async () => {
    const { resolver, request } = seasonFixture([searchHit(otherId), searchHit()], { [workId]: details(), [otherId]: details({ imdbID: otherId, totalSeasons: '2' }) });
    expect((await resolver.lookup(yearObservation)).state).toMatchObject({ kind: 'rated', record: { subject: { id: workId } } });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(['9', undefined])('does not guess when another year-matching title has season count %s', async count => {
    const { resolver, repo, request } = seasonFixture([searchHit(), searchHit(otherId)], {
      [workId]: details(), [otherId]: details({ imdbID: otherId, totalSeasons: count }),
    });
    expect((await resolver.lookup(yearObservation)).state).toEqual({ kind: 'needs_match', reason: 'ambiguous' });
    expect(await repo.get('mappings', titleKey(series.ref))).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([{ hits: [searchHit()], total: 11 }, { hits: [searchHit(), searchHit(otherId), searchHit('tt1234569')], total: 3 }])
    ('does not inspect details when the search is incomplete or has too many eligible candidates %#', async ({ hits, total }) => {
      const { resolver, request } = seasonFixture(hits, {}, total);
      expect((await resolver.lookup(yearObservation)).state).toEqual({ kind: 'needs_match', reason: 'ambiguous' });
      expect(request).toHaveBeenCalledTimes(1);
    });

  it.each([undefined, '9'])('refetches a fresh pre-upgrade rating only when its season count is missing (%s)', async count => {
    const { resolver, repo, request } = seasonFixture();
    const record = parseDetail(details({ totalSeasons: count }), workId, Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    expect((await resolver.lookup(yearObservation)).state).toMatchObject({ kind: 'rated', matchBasis: 'seasons' });
    expect(request).toHaveBeenCalledTimes(count === undefined ? 2 : 1);
  });

  it('does not reuse a negative cache entry after new season count evidence arrives', async () => {
    const { resolver, request } = seasonFixture();
    expect((await resolver.lookup({ ...yearObservation, seasonCount: 8 })).state.kind).toBe('needs_match');
    expect((await resolver.lookup(yearObservation)).state).toMatchObject({ kind: 'rated', matchBasis: 'seasons' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('prioritizes an explicit Wikidata ID over season evidence', async () => {
    const { resolver, request } = seasonFixture([], { [workId]: details({ totalSeasons: undefined }) }, 0,
      { kind: 'matched', imdbId: workId, entityIds: ['Q12345'], checkedAt: Date.now() });
    expect((await resolver.lookup(yearObservation)).state).toMatchObject({ kind: 'rated', identitySource: 'wikidata' });
    expect(request.mock.calls.map(call => call[0])).toEqual([{ i: workId, plot: 'short' }]);
  });

  it('does not bypass contradicting bound Hotstar cast evidence with season counts', async () => {
    const { resolver, request } = seasonFixture([searchHit()], { [workId]: details({ Actors: 'Other Actor, Another Actor, Third Actor' }) });
    expect((await resolver.lookup({ ...yearObservation, credits: cast })).state).toEqual({ kind: 'needs_match', reason: 'contradiction' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('leaves a rejected IMDb ID unresolved even when season evidence corroborates it', async () => {
    const { resolver, repo, request } = seasonFixture();
    const mapping: Mapping = { ref: series.ref, revision: 2, method: 'automatic', evidence: series, resolverVersion: 1, rejected: [workId] };
    await repo.put('mappings', titleKey(series.ref), mapping);
    expect((await resolver.lookup(yearObservation)).state.kind).toBe('needs_match');
    expect(await repo.get('mappings', titleKey(series.ref))).toEqual(mapping);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('OMDb season count normalization', () => {
  it.each(['1', '9', '200'])('retains a valid whole-series totalSeasons value %s', count => {
    expect(parseDetail(details({ totalSeasons: count }), workId, 1).seasonCount).toBe(Number(count));
  });

  it.each([undefined, 'N/A', '0', '201', '9.1', '09', '9 seasons', 9])('ignores unsupported totalSeasons value %s without discarding the rating', count => {
    const record = parseDetail(details({ totalSeasons: count }), workId, 1);
    expect(record.seasonCount).toBeUndefined();
    expect(record.score).toBe(8.1);
  });

  it('ignores seasons on a movie response', () => {
    expect(parseDetail(details({ Type: 'movie' }), workId, 1).seasonCount).toBeUndefined();
  });
});
