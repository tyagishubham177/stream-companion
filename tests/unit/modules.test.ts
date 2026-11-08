import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings, type TitleObservation } from '../../src/shared/contracts';
import { authoriseCommand, validateRequest } from '../../src/shared/validation';
import { MatchingLog } from '../../src/background/matching-log';
import { Repository } from '../../src/background/repository';
import { Resolver } from '../../src/background/resolver';
import type { Configuration } from '../../src/background/config';
import type { Scheduler } from '../../src/background/scheduler';
import { parseDetail } from '../../src/providers/omdb';
import { ratingKey, titleKey, RESOLVER_VERSION } from '../../src/shared/contracts';

const observation: TitleObservation = { ref: { platformId: 'netflix', titleId: '123' }, displayTitle: 'Fixture Film', mediaType: 'movie', year: { value: 2020, meaning: 'movie_release' }, adapterVersion: 3 };
describe('independent feature boundaries', () => {
  it.each(['ratingsEnabled','marksEnabled','shadeWatched','fadePassed','automaticMatching','matchingLogEnabled'] as const)('accepts only a boolean for %s', key => {
    expect(validateRequest({ protocol: 1, type: 'UPDATE_SETTINGS', settings: { [key]: false } })).toMatchObject({ settings: { [key]: false } });
    for (const value of ['false', 0, null, []]) expect(() => validateRequest({ protocol: 1, type: 'UPDATE_SETTINGS', settings: { [key]: value } })).toThrow();
  });
  it('bounds marks batches and prevents content from reading or resetting the library', () => {
    expect(() => validateRequest({ protocol: 1, type: 'GET_MARKS', refs: Array(101).fill(observation.ref) })).toThrow();
    for (const type of ['LIST_MARKS','EXPORT_MARKS','RESET_MARKS'] as const) expect(() => authoriseCommand('content', type)).toThrow();
    for (const plan of [['want'], 1, 'unknown']) expect(() => validateRequest({ protocol: 1, type: 'SET_MARK', observation, revision: 0, epoch: 0, plan })).toThrow();
    expect(() => validateRequest({ protocol: 1, type: 'SET_MARK', observation, revision: 0, epoch: 0 })).toThrow();
  });
  it('pauses new matching while allowing already saved identities to use cached ratings', async () => {
    const repo = new Repository(`module-${crypto.randomUUID()}`);
    const settings: Settings = { ...DEFAULT_SETTINGS, automaticMatching: false };
    const config = { settings: async () => settings, credential: async () => ({ key: 'fixture' }) } as unknown as Configuration;
    const request = vi.fn(); const direct = { resolve: vi.fn() };
    const resolver = new Resolver(repo, { request } as unknown as Scheduler, config, direct);
    expect((await resolver.lookup(observation)).state.kind).toBe('needs_match');
    expect(request).not.toHaveBeenCalled(); expect(direct.resolve).not.toHaveBeenCalled();
    const record = parseDetail({ Response:'True', Title:'Fixture Film', Year:'2020', Type:'movie', imdbID:'tt1234567', imdbRating:'8.2', imdbVotes:'100' }, 'tt1234567', Date.now());
    await repo.put('ratings', ratingKey(record.subject), record);
    await repo.put('mappings', titleKey(observation.ref), { ref: observation.ref, subject: record.subject, revision: 1, evidence: observation, rejected: [], method:'manual', resolverVersion: RESOLVER_VERSION });
    expect((await resolver.lookup(observation)).state.kind).toBe('rated');
    settings.ratingsEnabled = false;
    expect((await resolver.lookup(observation)).state.kind).toBe('disabled');
    expect(request).not.toHaveBeenCalled(); (await repo.open()).close();
  });
  it('turns diagnostic recording off without breaking atomic correction work or deleting existing logs', async () => {
    const repo = new Repository(`module-log-${crypto.randomUUID()}`), log = new MatchingLog(repo,'test');
    await log.append(log.event('opened',observation,0,0));
    log.recording = false;
    await log.append(log.event('search',observation,0,0));
    await log.automatic(observation,0,0,{kind:'needs_match',reason:'not_found'},[]);
    expect((await log.export()).map(event=>event.kind)).toEqual(['opened']);
    log.recording = true; await log.append(log.event('preview',observation,0,0));
    expect((await log.export()).map(event=>event.kind)).toEqual(['opened','preview']); (await repo.open()).close();
  });
});
