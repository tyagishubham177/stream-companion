import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import { Repository } from '../../src/background/repository';
import { Resolver } from '../../src/background/resolver';
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
