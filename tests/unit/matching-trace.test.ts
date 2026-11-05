import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Resolver, candidateChecks } from '../../src/background/resolver';
import { MatchingLog } from '../../src/background/matching-log';
import { Repository } from '../../src/background/repository';
import { DEFAULT_SETTINGS, RESOLVER_VERSION, ratingKey, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';
import type { DirectIdResult } from '../../src/providers/wikidata';
import type { NetflixMetadataResult } from '../../src/providers/netflix-metadata';
import { parseDetail } from '../../src/providers/omdb';

const observation: TitleObservation = { ref: { platformId: 'netflix', titleId: '9090' }, displayTitle: 'Fixture Film',
  mediaType: 'movie', year: { value: 2020, meaning: 'movie_release' }, adapterVersion: 2 };
const candidate = { id: 'tt1234567', title: 'Fixture Film', year: '2020', mediaType: 'movie' as const };
const detail = { Response: 'True', Title: candidate.title, Year: '2020', Type: 'movie', imdbID: candidate.id, imdbRating: '8.2', imdbVotes: '100' };
let repo: Repository;
let log: MatchingLog;
beforeEach(() => { repo = new Repository(`matching-trace-${crypto.randomUUID()}`); log = new MatchingLog(repo, '0.4.0'); });
afterEach(async () => { (await repo.open()).close(); vi.restoreAllMocks(); });
function setup(search = { candidates: [candidate], total: 1, page: 1 }, direct: DirectIdResult = { kind: 'missing' }, metadata: NetflixMetadataResult = { kind: 'missing' }) {
  const request = vi.fn(async (params: Record<string, string>, _explicit: boolean, decode: (raw: unknown) => unknown) => params.s ? search : decode(detail));
  const config = { settings: async () => DEFAULT_SETTINGS, credential: async () => ({ key: 'fixture-secret', id: 'fixture-credential', version: 1 }) } as unknown as Configuration;
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config,
    { resolve: async () => direct }, { resolve: async () => metadata }, log);
  return { resolver, request };
}

describe('automatic evidence for manual feedback', () => {
  it('records actual filters, full candidate order and distinct failed checks', async () => {
    const search = { candidates: [candidate, { ...candidate, id: 'tt7654321' },
      { ...candidate, id: 'tt9999999', title: 'Other Film', year: '1990' }], total: 3, page: 1 };
    const { resolver } = setup(search);
    expect((await resolver.lookup(observation)).state).toEqual({ kind: 'needs_match', reason: 'ambiguous' });
    const saved = await log.latest(observation, 0, 0);
    expect(saved?.outcome).toEqual({ kind: 'needs_match', reason: 'ambiguous' });
    expect(saved?.steps.find(step => step.search)?.search).toMatchObject({ query: 'Fixture Film', year: 2020, mediaType: 'movie',
      candidates: [{ id: candidate.id, checks: ['supported'] }, { id: 'tt7654321', checks: ['supported'] },
        { id: 'tt9999999', checks: ['title_mismatch', 'year_mismatch'] }] });
    expect(JSON.stringify(await log.export())).not.toMatch(/fixture-secret|fixture-credential|apikey|plot|Poster/);
  });
  it('records enriched public evidence rather than inventing a year for an unknown card', async () => {
    const weak = { ...observation, mediaType: 'unknown' as const, year: undefined, displayTitle: 'Localized Card' };
    const { resolver } = setup({ candidates: [], total: 0, page: 1 }, { kind: 'missing' },
      { kind: 'matched', title: candidate.title, mediaType: 'movie', year: 2020, checkedAt: Date.now() });
    await resolver.lookup(weak);
    const saved = await log.latest(weak, 0, 0);
    expect(saved?.steps.find(step => step.stage === 'enriched_evidence')?.evidence).toMatchObject({ displayTitle: candidate.title,
      mediaType: 'movie', year: { value: 2020, meaning: 'movie_release' }, aliases: ['Localized Card'] });
    expect(saved?.steps.find(step => step.search)?.search?.query).toBe(candidate.title);
  });
  it('distinguishes missing metadata from an OMDb search miss without making a search', async () => {
    const weak = { ...observation, mediaType: 'unknown' as const, year: undefined };
    const { resolver, request } = setup();
    await resolver.lookup(weak);
    expect(request).not.toHaveBeenCalled();
    const saved = await log.latest(weak, 0, 0);
    expect(saved?.steps).toContainEqual({ stage: 'netflix_metadata', outcome: 'missing' });
    expect(saved?.steps).toContainEqual({ stage: 'evidence', outcome: 'missing_usable_year_or_type' });
    expect(saved?.steps.some(step => step.search)).toBe(false);
  });
  it('marks incomplete result sets and does not assume the first candidate is unique', async () => {
    const { resolver } = setup({ candidates: [candidate], total: 20, page: 1 });
    await resolver.lookup(observation);
    expect((await log.latest(observation, 0, 0))?.steps.find(step => step.search)?.outcome).toBe('incomplete_set');
  });
  it('preserves failed search evidence across cached lookups and restart, but deletes it on Clear', async () => {
    const { resolver, request } = setup({ candidates: [], total: 0, page: 1 });
    await resolver.lookup(observation);
    const original = await log.latest(observation, 0, 0);
    await resolver.lookup(observation);
    expect(await log.latest(observation, 0, 0)).toEqual(original);
    const { resolver: restarted } = setup();
    await restarted.lookup(observation);
    expect(request).toHaveBeenCalledTimes(1);
    expect((await log.latest(observation, 0, 0))?.steps.find(step => step.search)?.search).toMatchObject({ query: candidate.title, total: 0, candidates: [] });
    await log.clear();
    await restarted.lookup(observation);
    const afterClear = await log.latest(observation, 0, 0);
    expect(afterClear?.steps.some(step => step.search)).toBe(false);
    expect(afterClear?.steps).toContainEqual({ stage: 'resolution_cache', outcome: 'previous_stop' });
  });
  it('keeps a working rating and reports log storage failure separately', async () => {
    vi.spyOn(log, 'automatic').mockRejectedValue(new Error('Synthetic storage failure'));
    const { resolver } = setup();
    expect((await resolver.lookup(observation)).state.kind).toBe('rated');
    expect(log.failed).toBe(true);
  });
  it('does not record manual mappings or explicit refreshes as automatic decisions', async () => {
    const mapping: Mapping = { ref: observation.ref, subject: { namespace: 'imdb', id: candidate.id }, revision: 2,
      evidence: observation, method: 'manual', resolverVersion: RESOLVER_VERSION, rejected: [] };
    await repo.put('mappings', titleKey(observation.ref), mapping);
    await repo.put('ratings', ratingKey(mapping.subject!), parseDetail(detail, candidate.id, Date.now()));
    const { resolver } = setup();
    await resolver.lookup(observation);
    await resolver.lookup(observation, true, 2);
    expect(await log.export()).toEqual([]);
  });
  it('distinguishes no numeric rating from an unresolved identity', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => params.s ? { candidates: [candidate], total: 1, page: 1 } : decode({ ...detail, imdbRating: 'N/A' }));
    await resolver.lookup(observation);
    expect((await log.latest(observation, 1, 0))?.outcome).toEqual({ kind: 'unrated', imdbId: candidate.id });
  });
  it('does not associate a stale in-flight result with a newer mapping revision', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (_params, _explicit, decode) => {
      await repo.put('mappings', titleKey(observation.ref), { ref: observation.ref, revision: 1, evidence: observation,
        method: 'manual', subject: { namespace: 'imdb', id: 'tt7654321' }, resolverVersion: RESOLVER_VERSION, rejected: [] } satisfies Mapping);
      return decode(detail);
    });
    // A direct-ID lookup avoids the unrelated search decoder in this race fixture.
    const config = { settings: async () => DEFAULT_SETTINGS, credential: async () => ({ key: 'fixture-secret' }) } as unknown as Configuration;
    const directResolver = new Resolver(repo, { request } as unknown as Scheduler, config,
      { resolve: async () => ({ kind: 'matched', imdbId: candidate.id, entityIds: ['Q9090'], checkedAt: Date.now() }) }, undefined, log);
    expect((await directResolver.lookup(observation)).state).toEqual({ kind: 'needs_match', reason: 'contradiction' });
    expect(await log.latest(observation, 1, 0)).toBeUndefined();
    expect(await log.latest(observation, 0, 0)).toBeUndefined();
    expect(resolver).toBeDefined();
  });
  it('explains all independent checks without treating a season year as a series start year', () => {
    expect(candidateChecks(observation, { ...candidate, title: 'Different', year: '1990', mediaType: 'series' }, [candidate.id]))
      .toEqual(['previously_rejected', 'title_mismatch', 'type_mismatch', 'year_mismatch']);
    expect(candidateChecks({ ...observation, mediaType: 'series', year: { value: 2020, meaning: 'season_release' } },
      { ...candidate, mediaType: 'series' }, [])).toEqual(['year_unverified']);
  });
});

it('upgrades the existing version-one database without losing mappings or cached ratings', async () => {
  const name = `matching-migration-${crypto.randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const mappings = request.result.createObjectStore('mappings', { keyPath: 'key' });
      mappings.put({ key: 'legacy', value: { revision: 8 } });
      const ratings = request.result.createObjectStore('ratings', { keyPath: 'key' });
      ratings.put({ key: 'legacy', value: { score: 7 } });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
  const upgraded = new Repository(name);
  try {
    expect(await upgraded.get('mappings', 'legacy')).toEqual({ revision: 8 });
    expect(await upgraded.get('ratings', 'legacy')).toEqual({ score: 7 });
    expect(await upgraded.all('matchingLogs')).toEqual([]);
  } finally { (await upgraded.open()).close(); }
});
