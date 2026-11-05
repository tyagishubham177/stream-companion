import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchingLog, LOG_LIMIT, LOG_RETENTION, candidateRecord, type MatchEvent, type MatchStep } from '../../src/background/matching-log';
import { Repository, txPut } from '../../src/background/repository';
import { RESOLVER_VERSION, titleKey, type TitleObservation } from '../../src/shared/contracts';
import { authoriseCommand, validateRequest, type SenderRole } from '../../src/shared/validation';

const now = Date.UTC(2026, 10, 5, 10);
const observation: TitleObservation = {
  ref: { platformId: 'netflix', titleId: '1001' }, displayTitle: 'Fixture Orbit', mediaType: 'movie',
  year: { value: 2020, meaning: 'movie_release' }, adapterVersion: 2,
};
const candidate = { id: 'tt1234567', title: 'Fixture Orbit', year: '2020', mediaType: 'movie' as const };
const steps: MatchStep[] = [{ stage: 'search', outcome: 'no_supported_candidates', evidence: observation,
  search: { query: 'Fixture Orbit', page: 1, year: 2020, mediaType: 'movie', total: 1,
    candidates: [{ ...candidate, checks: ['title_mismatch'] }] } }];
let repo: Repository;
let log: MatchingLog;
let databaseName: string;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  databaseName = `matching-log-${crypto.randomUUID()}`;
  repo = new Repository(databaseName);
  log = new MatchingLog(repo, '0.4.0-test');
});
afterEach(async () => { (await repo.open()).close(); vi.restoreAllMocks(); });

describe('local matching evidence', () => {
  it('persists automatic evidence across a reopened repository', async () => {
    await log.automatic(observation, 2, 3, { kind: 'needs_match', reason: 'not_found' }, steps);
    const saved = await log.latest(observation, 2, 3);
    (await repo.open()).close();
    const reopened = new Repository(databaseName);
    try {
      const restored = new MatchingLog(reopened, '0.4.0-test');
      expect(await restored.latest(observation, 2, 3)).toEqual(saved);
      expect(await restored.export()).toHaveLength(1);
    } finally { (await reopened.open()).close(); }
  });

  it('retains original searches when repeated cached outcomes contain no new search evidence', async () => {
    await log.automatic(observation, 2, 3, { kind: 'needs_match', reason: 'not_found' }, steps);
    const original = await log.latest(observation, 2, 3);
    vi.mocked(Date.now).mockReturnValue(now + 1000);
    await log.automatic(observation, 2, 3, { kind: 'needs_match', reason: 'not_found' }, [{ stage: 'resolution_cache', outcome: 'previous_stop' }]);
    expect(await log.latest(observation, 2, 3)).toEqual(original);
    expect(await log.export()).toHaveLength(1);
  });

  it('replaces the correlated automatic decision when its actual outcome changes', async () => {
    await log.automatic(observation, 2, 3, { kind: 'needs_match', reason: 'not_found' }, steps);
    await log.automatic(observation, 2, 3, { kind: 'needs_match', reason: 'ambiguous' }, steps);
    expect((await log.latest(observation, 2, 3))?.outcome).toEqual({ kind: 'needs_match', reason: 'ambiguous' });
    expect(await log.export()).toHaveLength(1);
  });

  it('requires exact revision, reset epoch, title reference and semantic observation correlation', async () => {
    await log.automatic(observation, 2, 3, { kind: 'needs_match', reason: 'not_found' }, steps);
    expect(await log.latest(observation, 3, 3)).toBeUndefined();
    expect(await log.latest(observation, 2, 4)).toBeUndefined();
    expect(await log.latest({ ...observation, displayTitle: 'Fixture Orbit 2' }, 2, 3)).toBeUndefined();
    expect(await log.latest({ ...observation, ref: { ...observation.ref, titleId: '1002' } }, 2, 3)).toBeUndefined();
    expect(await log.latest({ ...observation, year: { value: 2021, meaning: 'movie_release' } }, 2, 3)).toBeUndefined();
    expect((await log.latest(observation, 2, 3))?.resolverVersion).toBe(RESOLVER_VERSION);
  });

  it('does not collect disabled or unconfigured automatic states', async () => {
    await log.automatic(observation, 0, 0, { kind: 'disabled' }, []);
    await log.automatic(observation, 0, 0, { kind: 'setup_required' }, []);
    expect(await log.export()).toEqual([]);
  });

  it('expires correlation at 30 days and physically prunes expired records during export', async () => {
    await log.automatic(observation, 0, 0, { kind: 'needs_match', reason: 'not_found' }, steps);
    const opened = log.event('opened', observation, 0, 0);
    await log.append(opened);
    vi.mocked(Date.now).mockReturnValue(now + LOG_RETENTION + 1);
    expect(await log.latest(observation, 0, 0)).toBeUndefined();
    expect(await log.export()).toEqual([]);
    expect(await repo.all('matchingLogs')).toEqual([]);
  });

  it('retains the newest 1000 records while reserving history space by capping automatic records at 500', async () => {
    const automatic = log.event('automatic', observation, 0, 0);
    const correction = log.event('search', observation, 0, 0);
    await repo.transaction(['matchingLogs'], async tx => {
      for (let i = 0; i < 600; i++) txPut(tx, 'matchingLogs', `automatic-${i}`, { ...automatic, id: `automatic-${i}`, at: now - i } satisfies MatchEvent);
      for (let i = 0; i < 600; i++) txPut(tx, 'matchingLogs', `search-${i}`, { ...correction, id: `search-${i}`, at: now - 1000 - i } satisfies MatchEvent);
    });
    const exported = await log.export();
    expect(exported).toHaveLength(LOG_LIMIT);
    expect(exported.filter(event => event.kind === 'automatic')).toHaveLength(500);
    expect(exported.filter(event => event.kind === 'search')).toHaveLength(500);
    expect(exported.some(event => event.id === 'automatic-599')).toBe(false);
    expect(exported.some(event => event.id === 'search-599')).toBe(false);
    expect(exported.some(event => event.id === 'automatic-0')).toBe(true);
    expect(exported.some(event => event.id === 'search-0')).toBe(true);
  });

  it('rolls back a mapping change and confirmation record together if append fails', async () => {
    const key = titleKey(observation.ref);
    const previous = { revision: 1, subject: { namespace: 'imdb', id: 'tt7654321' } };
    await repo.put('mappings', key, previous);
    const append = log.appendInTransaction.bind(log);
    vi.spyOn(log, 'appendInTransaction').mockImplementation(async (tx, event) => {
      await append(tx, event);
      throw new Error('Synthetic log write failure');
    });
    await expect(repo.transaction(['mappings', 'matchingLogs', 'state'], async tx => {
      txPut(tx, 'mappings', key, { revision: 2, subject: { namespace: 'imdb', id: candidate.id } });
      await log.appendInTransaction(tx, log.event('confirmed', observation, 2, 0, { candidate }));
    }, true)).rejects.toThrow('Synthetic log write failure');
    expect(await repo.get('mappings', key)).toEqual(previous);
    expect(await log.export()).toEqual([]);
  });

  it('clears only matching logs, preserving saved mappings, ratings and request accounting', async () => {
    await repo.put('mappings', 'fixture', { revision: 1 });
    await repo.put('ratings', 'fixture', { score: 8 });
    await repo.put('attempts', 'fixture', { at: now });
    await log.append(log.event('opened', observation, 0, 0));
    await log.clear();
    expect(await log.export()).toEqual([]);
    expect(await repo.get('mappings', 'fixture')).toEqual({ revision: 1 });
    expect(await repo.get('ratings', 'fixture')).toEqual({ score: 8 });
    expect(await repo.get('attempts', 'fixture')).toEqual({ at: now });
  });

  it('exports only constructed candidate metadata rather than the raw provider object', async () => {
    const rawRecord = { subject: { id: candidate.id }, title: candidate.title, year: candidate.year, mediaType: candidate.mediaType,
      key: 'FIXTURE_SECRET', requestUrl: 'https://fixture.test/?apikey=FIXTURE_SECRET', rawResponse: { Poster: 'PRIVATE_FIXTURE_URL' } };
    await log.append(log.event('preview', observation, 0, 0, { candidate: candidateRecord(rawRecord) }));
    const exported = await log.export();
    expect(exported[0].candidate).toEqual(candidate);
    expect(JSON.stringify(exported)).not.toMatch(/FIXTURE_SECRET|apikey|PRIVATE_FIXTURE_URL|rawResponse|requestUrl/);
  });
});

describe('matching log command boundaries', () => {
  it.each(['EXPORT_MATCHING_LOG', 'CLEAR_MATCHING_LOG'] as const)('%s is options-only with no extra request fields', command => {
    expect(validateRequest({ protocol: 1, type: command })).toEqual({ protocol: 1, type: command });
    expect(() => authoriseCommand('options', command)).not.toThrow();
    for (const role of ['content', 'popup', 'correction'] as SenderRole[]) expect(() => authoriseCommand(role, command)).toThrow();
    expect(() => validateRequest({ protocol: 1, type: command, title: 'unexpected' })).toThrow();
  });

  it('keeps direct preview backward compatible and accepts a bounded optional search reference', () => {
    const request = { protocol: 1, type: 'PREVIEW_MATCH', contextId: crypto.randomUUID(), input: candidate.id };
    expect(validateRequest(request)).toEqual(request);
    const withSearch = { ...request, searchId: crypto.randomUUID() };
    expect(validateRequest(withSearch)).toEqual(withSearch);
    for (const searchId of ['', 'x'.repeat(37), 123, null, 'x'.repeat(35) + '\n']) {
      expect(() => validateRequest({ ...request, searchId })).toThrow();
    }
  });
});
