import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, ratingKey, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import { Resolver } from '../../src/background/resolver';
import { Repository } from '../../src/background/repository';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';
import { parseDetail, ProviderError } from '../../src/providers/omdb';
import type { NetflixMetadataResult } from '../../src/providers/netflix-metadata';

// All IDs, credits and scores are synthetic fixtures, including the named sequel example.
const id = 'tt9994101';
const credits = { directors: ['Fixture Director'], actors: ['First Actor', 'Second Actor', 'Third Actor'] };
const sourceTitle = 'Fixture The Revenge (Raw & Undekha)';
const baseTitle = 'Fixture The Revenge';
const ref = { platformId: 'netflix', titleId: '94101' };
const observation = (title = sourceTitle): TitleObservation => ({ ref, displayTitle: title, mediaType: 'unknown', adapterVersion: 1 });
const metadata = (title = sourceTitle, year = 2026): Extract<NetflixMetadataResult, { kind: 'matched' }> =>
  ({ kind: 'matched', title, year, mediaType: 'movie', checkedAt: Date.now(), credits });
const candidate = (extra = {}) => ({ Title: baseTitle, Year: '2026', Type: 'movie', imdbID: id, ...extra });
const detail = (extra = {}) => ({ Response: 'True', ...candidate(), imdbRating: '7.5', imdbVotes: '1234', Director: credits.directors.join(', '), Actors: credits.actors.join(', '), ...extra });
const search = (...items: ReturnType<typeof candidate>[]) => ({ Response: 'True', totalResults: String(items.length), Search: items });
let repo: Repository;
beforeEach(() => { repo = new Repository(`edition-resolution-${crypto.randomUUID()}`); });

function setup(source = metadata()) {
  const resolveMetadata = vi.fn(async (_ref: typeof ref, _demand: () => boolean, _requireCredits?: boolean): Promise<NetflixMetadataResult> => source);
  const resolveDirect = vi.fn(async () => ({ kind: 'missing' as const }));
  const request = vi.fn(async (params: Record<string, string>, _explicit: boolean, decode: (raw: unknown) => unknown) =>
    decode(params.s ? params.s === source.title ? search() : search(candidate()) : detail()));
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
const tombstone = (rejected = [id]): Mapping => ({ ref, revision: 1, method: 'automatic', evidence: observation(), resolverVersion: 4, rejected });

describe('corroborated edition resolution', () => {
  it.each(['Raw & Undekha', 'English', 'Hindi Dubbed'])('tries one bounded alias after the exact %s search misses', async label => {
    const title = `${baseTitle} (${label})`; const { resolver, request } = setup(metadata(title));
    expect(await resolver.lookup(observation(title))).toMatchObject({ revision: 1, state: { kind: 'rated', identitySource: 'netflix', record: { subject: { id }, score: 7.5 } } });
    expect(request.mock.calls.map(call => call[0])).toEqual([
      { s: title, y: '2026', type: 'movie', page: '1' },
      { s: baseTitle, y: '2026', type: 'movie', page: '1' },
      { i: id, plot: 'short' },
    ]);
    expect((await repo.get<Mapping>('mappings', titleKey(ref)))?.resolverVersion).toBe(4);
  });

  it('falls back after an exact provider not_found rather than caching it too early', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => {
      if (params.s === sourceTitle) throw new ProviderError('not_found', 'Synthetic miss');
      return decode(params.s ? search(candidate()) : detail());
    });
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps exact matches on the existing two-request path without requiring credits', async () => {
    const { resolver, request, resolveMetadata } = setup({ ...metadata(), credits: undefined });
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search(candidate({ Title: sourceTitle })) : detail({ Title: sourceTitle, Director: undefined, Actors: undefined })));
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
    expect(request).toHaveBeenCalledTimes(2);
    expect(resolveMetadata.mock.calls.some(call => call[2] === true)).toBe(false);
  });

  it('accepts a punctuation separator variant only with independent credits', async () => {
    const title = 'Fixture: 3'; const { resolver, request } = setup(metadata(title));
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search(candidate({ Title: 'Fixture 3' })) : detail({ Title: 'Fixture 3' })));
    expect((await resolver.lookup(observation(title))).state.kind).toBe('rated');
    expect(request.mock.calls.filter(call => call[0].s)).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reuses an eligible edition candidate from the complete initial search without an alias request', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? search(candidate()) : detail()));
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(call => !!call[0].s)).toHaveLength(1);
  });

  it('preserves sequel words and uses the authoritative 2026 release rather than the 2025 original', async () => {
    const title = 'Dhurandhar The Revenge (Raw & Undekha)'; const { resolver, request } = setup(metadata(title));
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s === title ? search() : params.s ? search(
      candidate({ Title: 'Dhurandhar', Year: '2025', imdbID: 'tt9994102' }), candidate({ Title: 'Dhurandhar: The Revenge' }),
    ) : detail({ Title: 'Dhurandhar: The Revenge' })));
    expect((await resolver.lookup(observation(title))).state).toMatchObject({ kind: 'rated', record: { year: '2026', subject: { id } } });
    expect(request.mock.calls[1][0]).toMatchObject({ s: 'Dhurandhar The Revenge', y: '2026' });
    expect(request.mock.calls[2][0].i).toBe(id);
  });

  it.each(['A True Story', 'The Revenge', 'Part II', 'Remastered'])('does not strip the unsupported or meaningful suffix %s', async label => {
    const title = `Fixture (${label})`; const { resolver, request } = setup(metadata(title));
    expect((await resolver.lookup(observation(title))).state.kind).toBe('needs_match');
    expect(request).toHaveBeenCalledTimes(1);
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
  });

  it.each([
    { Director: 'Different Director' }, { Actors: 'First Actor, Different Actor' },
    { Actors: 'First Actor, First Actor, First Actor' }, { Director: 'N/A' }, { Actors: 'N/A' },
    { Year: '2025' }, { Year: '2026–2027' }, { Type: 'series' }, { Title: 'Fixture' },
  ])('does not accept an edition detail with incompatible identity or credits %j', async mismatch => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? params.s === sourceTitle ? search() : search(candidate()) : detail(mismatch)));
    expect((await resolver.lookup(observation())).state.kind).not.toBe('rated');
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
    expect(request.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it.each([
    search(candidate(), candidate({ imdbID: 'tt9994102' })),
    { ...search(candidate()), totalResults: '11' },
    search(candidate({ Type: 'series' })), search(candidate({ Year: '2026–2027' })),
  ])('does not detail-fetch an ambiguous, incomplete or unsupported alias result %#', async aliases => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s === sourceTitle ? search() : aliases));
    expect((await resolver.lookup(observation())).state.kind).toBe('needs_match');
    expect(request).toHaveBeenCalledTimes(2);
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
  });

  it.each([
    search(candidate({ Title: sourceTitle }), candidate({ Title: sourceTitle, imdbID: 'tt9994102' })),
    { ...search(candidate({ Title: sourceTitle })), totalResults: '11' },
  ])('does not use edition fallback to bypass an ambiguous or incomplete exact result %#', async exact => {
    const { resolver, request } = setup(); request.mockImplementation(async (_params, _explicit, decode) => decode(exact));
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'needs_match', reason: 'ambiguous' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('upgrades legacy public metadata credits only when the exact lookup fails', async () => {
    const { resolver, request, resolveMetadata } = setup({ ...metadata(), credits: undefined });
    resolveMetadata.mockImplementation(async (_ref, _demand, requireCredits) => requireCredits ? metadata() : { ...metadata(), credits: undefined });
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
    expect(resolveMetadata.mock.calls.map(call => call[2] === true)).toEqual([false, true]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('remains unresolved without usable upgraded public credits and avoids a detail request', async () => {
    const { resolver, request } = setup({ ...metadata(), credits: undefined });
    expect((await resolver.lookup(observation())).state.kind).not.toBe('rated');
    expect(request.mock.calls.some(call => !!call[0].i)).toBe(false);
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
  });

  it.each([
    metadata(sourceTitle, 2025), metadata('Another Fixture (Raw & Undekha)'),
  ])('rejects changed authoritative evidence discovered during a public credit upgrade %#', async changed => {
    const { resolver, request, resolveMetadata } = setup({ ...metadata(), credits: undefined });
    resolveMetadata.mockImplementation(async (_ref, _demand, requireCredits) => requireCredits ? changed : { ...metadata(), credits: undefined });
    expect((await resolver.lookup(observation())).state.kind).not.toBe('rated');
    expect(request.mock.calls.some(call => !!call[0].i)).toBe(false);
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
  });

  it('does not use edition searches to conceal a temporary exact-search provider error', async () => {
    const { resolver, request } = setup(); request.mockRejectedValue(new ProviderError('quota', 'Synthetic quota pause'));
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'deferred', reason: 'quota' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await repo.get('mappings', titleKey(ref))).toBeUndefined();
  });

  it('refetches a fresh legacy detail snapshot without credits within the same three-request budget', async () => {
    const record = parseDetail(detail({ Director: undefined, Actors: undefined }), id, Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    const { resolver, request } = setup();
    expect((await resolver.lookup(observation())).state.kind).toBe('rated');
    expect(request).toHaveBeenCalledTimes(3); expect(request.mock.calls[2][0].i).toBe(id);
  });

  it('reuses a fresh independently corroborated detail snapshot', async () => {
    const record = parseDetail(detail(), id, Date.now()); await repo.put('ratings', ratingKey(record.subject), record);
    const { resolver, request } = setup();
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'rated', record: { fetchedAt: record.fetchedAt } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not restore a rejected identity through an edition alias', async () => {
    await repo.put('mappings', titleKey(ref), tombstone()); const { resolver, request } = setup();
    expect((await resolver.lookup(observation())).state.kind).toBe('needs_match');
    expect(request.mock.calls.some(call => !!call[0].i)).toBe(false);
    expect((await repo.get<Mapping>('mappings', titleKey(ref)))?.subject).toBeUndefined();
  });

  it.each(['manual', 'reset'] as const)('does not overwrite a %s decision while edition details are pending', async action => {
    const { resolver, request } = setup(); const gate = deferred<unknown>();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? params.s === sourceTitle ? search() : search(candidate()) : await gate.promise));
    const pending = resolver.lookup(observation()); await vi.waitFor(() => expect(request.mock.calls.some(call => !!call[0].i)).toBe(true));
    if (action === 'manual') await repo.put('mappings', titleKey(ref), { ...tombstone([]), method: 'manual', subject: { namespace: 'imdb', id: 'tt9994102' } });
    else await repo.put('state', 'mappingEpoch', 1);
    gate.release(detail()); expect((await pending).state.kind).not.toBe('rated');
    const mapping = await repo.get<Mapping>('mappings', titleKey(ref));
    if (action === 'manual') expect(mapping).toMatchObject({ method: 'manual', subject: { id: 'tt9994102' } });
    else expect(mapping).toBeUndefined();
  });

  it('stores a corroborated identity with an unavailable rating as unrated', async () => {
    const { resolver, request } = setup();
    request.mockImplementation(async (params, _explicit, decode) => decode(params.s ? params.s === sourceTitle ? search() : search(candidate()) : detail({ imdbRating: 'N/A' })));
    expect((await resolver.lookup(observation())).state).toMatchObject({ kind: 'unrated', identitySource: 'netflix', record: { score: null } });
    expect((await repo.get<Mapping>('mappings', titleKey(ref)))?.subject?.id).toBe(id);
  });
});
