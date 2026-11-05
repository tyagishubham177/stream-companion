import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchingLog, type MatchEvent } from '../../src/background/matching-log';
import { Repository } from '../../src/background/repository';
import { Resolver } from '../../src/background/resolver';
import { DEFAULT_SETTINGS, type TitleObservation } from '../../src/shared/contracts';
import { ProviderError } from '../../src/providers/omdb';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';

const observation: TitleObservation = { ref: { platformId: 'netflix', titleId: '9901' }, displayTitle: 'Fixture Clear Race',
  mediaType: 'movie', year: { value: 2020, meaning: 'movie_release' }, adapterVersion: 2 };
const config = { settings: async () => DEFAULT_SETTINGS,
  credential: async () => ({ key: 'fixture-only', id: 'fixture-credential', version: 1 }) } as unknown as Configuration;
let repo: Repository;
let log: MatchingLog;
beforeEach(() => { repo = new Repository(`matching-clear-${crypto.randomUUID()}`); log = new MatchingLog(repo, '0.4.0-test'); });
afterEach(async () => { (await repo.open()).close(); vi.restoreAllMocks(); });

function gate() {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  return { release, started, waiting, entered };
}

describe('clearing matching history during in-flight work', () => {
  it('drops an old automatic search completion and does not restore its cached search history on a new lookup', async () => {
    const pending = gate();
    const request = vi.fn(async () => {
      pending.started(); await pending.waiting;
      throw new ProviderError('not_found', 'Synthetic missing title');
    });
    const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, undefined, undefined, log);
    const lookup = resolver.lookup(observation);
    await pending.entered;
    expect(await log.generation()).toBe(0);
    await log.clear();
    expect(await log.generation()).toBe(1);
    pending.release();
    expect((await lookup).state).toEqual({ kind: 'needs_match', reason: 'not_found' });
    expect(await log.export()).toEqual([]);
    const oldResolutions = await repo.all<{ trace?: unknown; traceEpoch?: number }>('resolutions');
    expect(oldResolutions).toHaveLength(1);
    for (const { value } of oldResolutions) {
      expect(value.trace).toBeUndefined();
      expect(value.traceEpoch).toBeUndefined();
    }

    const freshRequest = vi.fn(async () => { throw new Error('Cached misses must not fetch again'); });
    const next = new Resolver(repo, { request: freshRequest } as unknown as Scheduler, config, undefined, undefined, log);
    expect((await next.lookup(observation)).state).toEqual({ kind: 'needs_match', reason: 'not_found' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(freshRequest).not.toHaveBeenCalled();
    const events = await log.export();
    expect(events).toHaveLength(1);
    expect(events[0].logEpoch).toBe(1);
    expect(events[0].automatic?.steps).toEqual([
      { stage: 'lookup', outcome: 'automatic', evidence: observation },
      { stage: 'resolution_cache', outcome: 'previous_stop' },
    ]);
    expect(events[0].automatic?.steps.some(step => step.search)).toBe(false);
  });

  it('does not restore an old direct-ID validation trace written after clearing', async () => {
    const pending = gate();
    const request = vi.fn(async () => {
      pending.started(); await pending.waiting;
      throw new ProviderError('not_found', 'Synthetic unavailable detail');
    });
    const direct = { resolve: async () => ({ kind: 'matched' as const, imdbId: 'tt1234567', entityIds: ['Q9901'], checkedAt: Date.now() }) };
    const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, direct, undefined, log);
    const lookup = resolver.lookup(observation);
    await pending.entered;
    await log.clear();
    pending.release();
    expect((await lookup).state).toEqual({ kind: 'needs_match', reason: 'not_found' });
    expect(await log.export()).toEqual([]);
    const oldResolutions = await repo.all<{ trace?: unknown; traceEpoch?: number }>('resolutions');
    expect(oldResolutions).toHaveLength(1);
    for (const { value } of oldResolutions) {
      expect(value.trace).toBeUndefined();
      expect(value.traceEpoch).toBeUndefined();
    }

    const freshRequest = vi.fn(async () => { throw new Error('Cached validation must not fetch again'); });
    const next = new Resolver(repo, { request: freshRequest } as unknown as Scheduler, config, direct, undefined, log);
    await next.lookup(observation);
    expect(freshRequest).not.toHaveBeenCalled();
    const events = await log.export();
    expect(events).toHaveLength(1);
    expect(events[0].logEpoch).toBe(1);
    expect(events[0].automatic?.steps.map(step => step.stage)).toEqual(['lookup', 'wikidata', 'resolution_cache']);
  });

  it('rejects late manual search/failure events from expired sessions while accepting new-generation activity', async () => {
    const sessionId = crypto.randomUUID();
    const search = log.event('search', observation, 0, 0, { sessionId,
      search: { id: crypto.randomUUID(), query: 'Fixture Clear Race', page: 1, total: 0, candidates: [] } }, await log.generation());
    const failure = log.event('failure', observation, 0, 0, { sessionId, reason: 'search:storage_or_validation' }, search.logEpoch);
    await repo.put('contexts', sessionId, { id: sessionId, observation });
    await log.append(search);
    await log.clear();
    expect(await repo.get('contexts', sessionId)).toBeUndefined();
    await log.append(search);
    await log.append(failure);
    expect(await log.export()).toEqual([]);
    const newEvent = log.event('opened', observation, 0, 0, { sessionId: crypto.randomUUID() }, await log.generation());
    await log.append(newEvent);
    expect(await log.export()).toEqual([newEvent]);
    expect(newEvent.logEpoch).toBe(1);
  });

  it('clears diagnostic traces and contexts without changing resolution outcomes, cached ratings, mappings or request protections', async () => {
    const state = { kind: 'needs_match', reason: 'ambiguous' };
    const resolution = { state, attempts: 2, expiresAt: Date.now() + 3600000,
      trace: [{ stage: 'omdb_search', outcome: 'complete_set', search: { query: 'Old search', total: 0, page: 1, candidates: [] } }], traceEpoch: 0 };
    await repo.put('resolutions', 'fixture-resolution', resolution);
    await repo.put('state', 'mappingEpoch', 7);
    await repo.put('state', 'fixture-cooldown', { until: Date.now() + 500000 });
    await repo.put('attempts', 'fixture-attempt', { at: Date.now() });
    await repo.put('leases', 'fixture-lease', { until: Date.now() + 1000 });
    await repo.put('ratings', 'fixture-rating', { score: 8 });
    await repo.put('mappings', 'fixture-mapping', { revision: 3 });
    await repo.put('contexts', 'fixture-session', { observation });
    await log.append(log.event('opened', observation, 0, 0));
    const preserved = await Promise.all(['state', 'attempts', 'leases', 'ratings', 'mappings'].map(store => repo.all(store as 'state' | 'attempts' | 'leases' | 'ratings' | 'mappings')));
    await log.clear();
    expect(await log.export()).toEqual([]);
    expect(await repo.all('contexts')).toEqual([]);
    expect(await repo.get('resolutions', 'fixture-resolution')).toEqual({ state, attempts: 2, expiresAt: resolution.expiresAt });
    const states = await repo.all('state');
    expect(states.filter(entry => entry.key !== 'matchingLogEpoch')).toEqual(preserved[0]);
    expect(await log.generation()).toBe(1);
    for (const [index, store] of (['attempts', 'leases', 'ratings', 'mappings'] as const).entries())
      expect(await repo.all(store)).toEqual(preserved[index + 1]);
    expect(await repo.all<MatchEvent>('matchingLogs')).toEqual([]);
  });
});
