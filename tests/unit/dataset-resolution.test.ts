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
