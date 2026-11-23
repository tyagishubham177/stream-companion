import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, titleKey, type Mapping, type TitleObservation } from '../../src/shared/contracts';
import { Resolver } from '../../src/background/resolver';
import { Repository } from '../../src/background/repository';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';

const observation: TitleObservation = { ref: { platformId: 'netflix', titleId: '101' }, displayTitle: 'Fixture Orbit', mediaType: 'unknown', adapterVersion: 1 };
const subject = { namespace: 'imdb', id: 'tt1234567' } as const;

it('rates a previously verified title without an OMDb key or cached title details', async () => {
  const repo = new Repository(`dataset-resolution-${crypto.randomUUID()}`);
  await repo.put('mappings', titleKey(observation.ref), { ref: observation.ref, subject, evidence: observation,
    method: 'manual', revision: 1, rejected: [], resolverVersion: 1 } satisfies Mapping);
  const request = vi.fn();
  const config = { settings: async () => ({ ...DEFAULT_SETTINGS }), credential: async () => undefined } as unknown as Configuration;
  const rate = vi.fn(async record => ({ ...record, provider: 'imdb-dataset' as const, score: 7.5, votes: 123, fetchedAt: Date.now() }));
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, undefined, undefined, undefined, rate);

  expect(await resolver.lookup(observation)).toMatchObject({ revision: 1, state: { kind: 'rated', method: 'manual',
    record: { subject, mediaType: 'unknown', score: 7.5, votes: 123, provider: 'imdb-dataset' } } });
  expect(request).not.toHaveBeenCalled();
});

it('reads saved mappings in a local batch without invoking any network resolver', async () => {
  const repo = new Repository(`dataset-cache-${crypto.randomUUID()}`);
  await repo.put('mappings', titleKey(observation.ref), { ref: observation.ref, subject, evidence: observation,
    method: 'manual', revision: 1, rejected: [], resolverVersion: 1 } satisfies Mapping);
  const request = vi.fn(), resolve = vi.fn(), credential = vi.fn(), rate = vi.fn();
  const config = { settings: async () => ({ ...DEFAULT_SETTINGS }), credential } as unknown as Configuration;
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, { resolve }, undefined, undefined, rate);
  const scores = vi.fn(async () => new Map([[subject.id, { score: 7.5, votes: 123, fetchedAt: Date.now() - 86400001 }]]));
  const misses = { ...observation, ref: { ...observation.ref, titleId: '102' } };
  expect(await resolver.lookupCached([observation, misses, observation], scores)).toMatchObject([
    { cached: true, revision: 1, state: { kind: 'rated', stale: true, record: { score: 7.5 } } }, null,
    { cached: true, revision: 1, state: { kind: 'rated', stale: true } },
  ]);
  expect(scores).toHaveBeenCalledExactlyOnceWith([subject.id]);
  for (const remote of [request, resolve, credential, rate]) expect(remote).not.toHaveBeenCalled();
});

it('accepts an exact platform ID with corroborating work metadata without an OMDb key', async () => {
  const repo = new Repository(`dataset-direct-${crypto.randomUUID()}`);
  const request = vi.fn(), credential = vi.fn(async () => undefined);
  const config = { settings: async () => ({ ...DEFAULT_SETTINGS }), credential } as unknown as Configuration;
  const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, { resolve: async () => ({
    kind: 'matched', imdbId: subject.id, checkedAt: Date.now(), entityIds: ['Q123'],
    work: { title: 'Fixture Orbit', mediaType: 'series', year: 2021 },
  }) }, undefined, undefined, async record => ({ ...record, score: 7.5, votes: 123, fetchedAt: Date.now() }));
  expect(await resolver.lookup(observation)).toMatchObject({ revision: 1, state: { kind: 'rated', identitySource: 'wikidata',
    record: { subject, mediaType: 'series', year: '2021', score: 7.5 } } });
  expect(request).not.toHaveBeenCalled();
  expect(credential).not.toHaveBeenCalled();
  expect(await repo.get('mappings', titleKey(observation.ref))).toMatchObject({ subject, details: { year: '2021' } });
});
