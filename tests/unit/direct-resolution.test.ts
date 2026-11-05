import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, ratingKey, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import { Resolver } from '../../src/background/resolver';
import { Repository } from '../../src/background/repository';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';
import { parseDetail } from '../../src/providers/omdb';
import type { DirectIdResult } from '../../src/providers/wikidata';

const observation: TitleObservation = {
  ref: { platformId: 'netflix', titleId: '1001' },
  displayTitle: 'Fixture Orbit', mediaType: 'unknown', adapterVersion: 1,
};
const raw = { Response: 'True', Title: 'Fixture Orbit', Year: '2020', Type: 'movie', imdbID: 'tt1234567', imdbRating: '8.2', imdbVotes: '1,234' };
const matched = (): DirectIdResult => ({ kind: 'matched', imdbId: raw.imdbID, entityIds: ['Q1234'], checkedAt: Date.now() });
let repo: Repository;
beforeEach(() => { repo = new Repository(`direct-resolution-${crypto.randomUUID()}`); });

function setup(result: DirectIdResult = matched(), response: unknown = raw) {
  const request = vi.fn(async (_params: Record<string, string>, _explicit: boolean, decode: (raw: unknown) => unknown) => decode(response));
  const resolve = vi.fn(async (): Promise<DirectIdResult> => result);
  const config = {
    settings: async () => ({ ...DEFAULT_SETTINGS }),
    credential: async () => ({ key: 'synthetic-key', id: 'synthetic-credential', version: 1 }),
  } as unknown as Configuration;
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, { resolve });
  return { resolver, request, resolve, config };
}
function mapping(method: Mapping['method'] = 'automatic', revision = 1): Mapping {
  return { ref: observation.ref, subject: { namespace: 'imdb', id: raw.imdbID }, evidence: observation,
    method, revision, rejected: [], resolverVersion: 1 };
}
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}

describe('automatic resolution from streaming title IDs', () => {
  it('rates a title-only card by unique ID without a title search or opening details', async () => {
    const { resolver, request } = setup();
    const result = await resolver.lookup(observation);
    expect(result).toMatchObject({ revision: 1, state: { kind: 'rated', identitySource: 'wikidata', record: { score: 8.2 } } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ i: raw.imdbID, plot: 'short' });
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.provenance).toMatchObject({ source: 'wikidata', entityIds: ['Q1234'] });
  });

  it('uses the ID relationship despite a localized display label', async () => {
    const { resolver } = setup();
    expect((await resolver.lookup({ ...observation, displayTitle: 'कक्षा' })).state).toMatchObject({ kind: 'rated', record: { title: 'Fixture Orbit' } });
  });

  it.each([
    { ...observation, mediaType: 'series' },
    { ...observation, mediaType: 'movie', year: { value: 2021, meaning: 'movie_release' } },
  ] satisfies TitleObservation[])('does not persist a direct match contradicting explicit metadata %j', async o => {
    const { resolver } = setup();
    expect((await resolver.lookup(o)).state).toMatchObject({ kind: 'needs_match', reason: 'contradiction' });
    expect(await repo.get('mappings', titleKey(o.ref))).toBeUndefined();
  });

  it('never saves an episode as the whole streaming work', async () => {
    const { resolver } = setup(matched(), { ...raw, Type: 'episode' });
    const result = await resolver.lookup(observation);
    expect(result.state.kind).not.toBe('rated');
    expect(result.state.kind).not.toBe('unrated');
    expect(await repo.get('mappings', titleKey(observation.ref))).toBeUndefined();
  });

  it('rejects a detail response for a different IMDb identity', async () => {
    const { resolver } = setup(matched(), { ...raw, imdbID: 'tt7654321' });
    expect((await resolver.lookup(observation)).state.kind).not.toBe('rated');
    expect(await repo.get('mappings', titleKey(observation.ref))).toBeUndefined();
  });

  it.each([{ kind: 'missing' }, { kind: 'ambiguous' }] satisfies DirectIdResult[])('does not invent a numeric rating for a %j relationship', async direct => {
    const { resolver, request } = setup(direct);
    const result = await resolver.lookup(observation);
    expect(result.state.kind).toBe('needs_match');
    expect(request).not.toHaveBeenCalled();
    expect(await repo.get('mappings', titleKey(observation.ref))).toBeUndefined();
  });

  it('keeps temporary identity-service failures retryable', async () => {
    const { resolver, resolve, request } = setup();
    resolve.mockResolvedValueOnce({ kind: 'deferred', reason: 'provider', message: 'Try later', retryAfter: Date.now() });
    expect((await resolver.lookup(observation)).state).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(request).not.toHaveBeenCalled();
    expect((await resolver.lookup(observation)).state.kind).toBe('rated');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('preserves a fresh successful v1 automatic mapping instead of stranding it after upgrade', async () => {
    await repo.put('mappings', titleKey(observation.ref), mapping());
    const record = parseDetail(raw, raw.imdbID, Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    const { resolver, resolve, request } = setup();
    expect((await resolver.lookup(observation)).state).toMatchObject({ kind: 'rated', record: { score: 8.2 } });
    expect(resolve).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it('preserves an existing manual choice before consulting a new ID source', async () => {
    await repo.put('mappings', titleKey(observation.ref), mapping('manual', 3));
    const record = parseDetail(raw, raw.imdbID, Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    const { resolver, resolve } = setup({ kind: 'ambiguous' });
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 3, state: { kind: 'rated', method: 'manual' } });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('cannot reselect an IMDb ID rejected for this source title', async () => {
    await repo.put('mappings', titleKey(observation.ref), { ...mapping(), subject: undefined, revision: 2, rejected: [raw.imdbID] });
    const { resolver, request } = setup();
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 2, state: { kind: 'needs_match', reason: 'contradiction' } });
    expect(request).not.toHaveBeenCalled();
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.subject).toBeUndefined();
  });

  it('keeps a confirmed work without a provider score as NR and still saves its identity', async () => {
    const { resolver } = setup(matched(), { ...raw, imdbRating: 'N/A', imdbVotes: 'N/A' });
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 1, state: { kind: 'unrated', identitySource: 'wikidata', record: { score: null, votes: null } } });
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.subject?.id).toBe(raw.imdbID);
  });

  it('shares a fresh external-ID rating cache when establishing a new streaming mapping', async () => {
    const record = parseDetail(raw, raw.imdbID, Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    const { resolver, request } = setup();
    expect((await resolver.lookup(observation)).state.kind).toBe('rated');
    expect(request).not.toHaveBeenCalled();
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.subject?.id).toBe(raw.imdbID);
  });

  it('does not overwrite a manual correction committed while an ID lookup is pending', async () => {
    const { resolver, resolve } = setup(); const gate = deferred<DirectIdResult>();
    resolve.mockImplementationOnce(() => gate.promise);
    const pending = resolver.lookup(observation);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    await repo.put('mappings', titleKey(observation.ref), { ...mapping('manual'), subject: { namespace: 'imdb', id: 'tt7654321' } });
    gate.release(matched());
    expect(await pending).toMatchObject({ revision: 1, state: { kind: 'needs_match' } });
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.subject?.id).toBe('tt7654321');
  });

  it('cannot create an absent mapping after a global reset while its ID lookup is pending', async () => {
    const { resolver, resolve } = setup(); const gate = deferred<DirectIdResult>();
    resolve.mockImplementationOnce(() => gate.promise);
    const pending = resolver.lookup(observation);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    await repo.put('state', 'mappingEpoch', 1); gate.release(matched());
    expect((await pending).state.kind).toBe('needs_match');
    expect(await repo.get('mappings', titleKey(observation.ref))).toBeUndefined();
  });

  it('gives deduplicated consumers the same committed revision', async () => {
    const { resolver, resolve, request } = setup(); const gate = deferred<DirectIdResult>();
    resolve.mockImplementationOnce(() => gate.promise);
    const first = resolver.lookup(observation);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    const second = resolver.lookup(observation);
    await new Promise(resolve => setTimeout(resolve, 0)); gate.release(matched());
    const results = await Promise.all([first, second]);
    expect(results.map(r => r.revision)).toEqual([1, 1]);
    expect(results.every(r => r.state.kind === 'rated')).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
  });

  it('returns the compatible winning automatic match to concurrent observations with different evidence', async () => {
    const { resolver, resolve } = setup(); const gate = deferred<DirectIdResult>();
    resolve.mockImplementation(() => gate.promise);
    const titleOnly = resolver.lookup(observation);
    const enriched = resolver.lookup({ ...observation, mediaType: 'movie', year: { value: 2020, meaning: 'movie_release' } });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    gate.release(matched());
    const results = await Promise.all([titleOnly, enriched]);
    expect(results.every(result => result.state.kind === 'rated')).toBe(true);
    expect(results.map(result => result.revision)).toEqual([1, 1]);
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.subject?.id).toBe(raw.imdbID);
  });
});

describe('automatic source relationship revalidation', () => {
  async function seed(method: Mapping['method'] = 'automatic') {
    const old = { ...mapping(method), provenance: { source: 'wikidata' as const, entityIds: ['Q1234'], checkedAt: Date.now() - 31 * 86400000 } };
    const record = parseDetail(raw, raw.imdbID, Date.now());
    await repo.put('mappings', titleKey(observation.ref), old);
    await repo.put('ratings', ratingKey(record.subject), record);
    return { old, record };
  }

  it('refreshes expired source provenance while reusing a fresh rating for the same identity', async () => {
    const { record } = await seed(); const direct = matched();
    const { resolver, resolve, request } = setup(direct);
    const result = await resolver.lookup(observation);
    expect(result).toMatchObject({ revision: 2, state: { kind: 'rated', record: { fetchedAt: record.fetchedAt } } });
    expect(resolve).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.provenance?.checkedAt).toBe(direct.kind === 'matched' ? direct.checkedAt : undefined);
  });

  it('validates a changed automatic source identity before updating its saved mapping', async () => {
    await seed();
    const changed: DirectIdResult = { kind: 'matched', imdbId: 'tt7654321', entityIds: ['Q4321'], checkedAt: Date.now() };
    const { resolver, resolve, request } = setup(changed, { ...raw, imdbID: 'tt7654321', Title: 'Fixture corrected identity' });
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 2, state: { kind: 'rated', record: { subject: { id: 'tt7654321' } } } });
    expect(resolve).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ i: 'tt7654321', plot: 'short' });
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.subject?.id).toBe('tt7654321');
  });

  it.each([{ kind: 'missing' }, { kind: 'ambiguous' }] satisfies DirectIdResult[])('does not retain an old numeric badge when an expired source becomes %j', async direct => {
    await seed(); const { resolver, resolve, request } = setup(direct);
    expect((await resolver.lookup(observation)).state.kind).toBe('needs_match');
    expect(resolve).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
  });

  it('keeps a compatible known rating during a temporary source outage', async () => {
    const { record } = await seed();
    const { resolver, resolve, request } = setup({ kind: 'deferred', reason: 'provider', message: 'Try later' });
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 1, state: { kind: 'rated', record: { fetchedAt: record.fetchedAt } } });
    expect(resolve).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
  });

  it('never revalidates a manual choice against a changed public source', async () => {
    await seed('manual'); const { resolver, resolve, request } = setup({ kind: 'ambiguous' });
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 1, state: { kind: 'rated', method: 'manual', record: { subject: { id: raw.imdbID } } } });
    expect(resolve).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it('uses the existing saved identity in cache-only mode without a source lookup', async () => {
    await seed(); const { resolver, resolve, request, config } = setup({ kind: 'ambiguous' });
    vi.spyOn(config, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, cacheOnly: true });
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 1, state: { kind: 'rated', record: { subject: { id: raw.imdbID } } } });
    expect(resolve).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it('keeps explicit Refresh as a budgeted rating refresh even when source provenance is old', async () => {
    await seed(); const { resolver, resolve, request } = setup();
    expect(await resolver.lookup(observation, true, 1)).toMatchObject({ revision: 1, state: { kind: 'rated', record: { subject: { id: raw.imdbID } } } });
    expect(resolve).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ i: raw.imdbID, plot: 'short' });
    expect(request.mock.calls[0][1]).toBe(true);
  });
});
