import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarksService, MARK_UNDO_MS } from '../../src/background/marks';
import { Repository } from '../../src/background/repository';
import { titleKey, type TitleObservation } from '../../src/shared/contracts';
import { hasMarks, markLabel } from '../../src/shared/marks';

const observed: TitleObservation = { ref: { platformId: 'netflix', titleId: '1001' }, displayTitle: 'Fixture Favourite', mediaType: 'unknown', adapterVersion: 3 };
const now = Date.UTC(2026, 10, 8, 12);
let repo: Repository;
let service: MarksService;
let databaseName: string;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  databaseName = `marks-${crypto.randomUUID()}`; repo = new Repository(databaseName); service = new MarksService(repo);
});
afterEach(async () => { (await repo.open()).close(); vi.restoreAllMocks(); });

describe('durable user marks', () => {
  it('starts with an empty batch and deduplicates requested identities', async () => {
    expect(await service.get([observed.ref])).toEqual({ marks: [], epoch: 0 });
    const result = await service.set(observed, { watched: true }, 0, 0);
    expect((await service.get([observed.ref, observed.ref])).marks).toEqual([result.mark]);
  });
  it('keeps watched independent of wanting to rewatch or choosing to pass', async () => {
    const first = await service.set(observed, { watched: true }, 0, 0);
    const later = await service.set(observed, { plan: 'want' }, first.mark.revision, 0);
    expect(later.mark).toMatchObject({ watched: true, plan: 'want', revision: 2 });
    const passed = await service.set(observed, { plan: 'pass' }, later.mark.revision, 0);
    expect(passed.mark).toMatchObject({ watched: true, plan: 'pass', revision: 3 });
    const clearPlan = await service.set(observed, { plan: 'none' }, passed.mark.revision, 0);
    expect(clearPlan.mark).toMatchObject({ watched: true, plan: 'none' });
  });
  it('does not silently remove a plan when marking watched', async () => {
    const queued = await service.set(observed, { plan: 'want' }, 0, 0);
    expect((await service.set(observed, { watched: true }, queued.mark.revision, 0)).mark)
      .toMatchObject({ watched: true, plan: 'want' });
  });
  it('persists display metadata independently of ratings and across reopening', async () => {
    await service.set(observed, { plan: 'want' }, 0, 0);
    await repo.clear('ratings');
    (await repo.open()).close();
    const reopened = new Repository(databaseName);
    try {
      expect((await new MarksService(reopened).list()).marks[0]).toMatchObject({ observation: observed, plan: 'want' });
    } finally { (await reopened.open()).close(); }
  });
  it('does not expire user choices during cache pruning', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    vi.mocked(Date.now).mockReturnValue(now + 400 * 86400000);
    await repo.prune(Date.now());
    expect((await service.list()).marks).toEqual([saved.mark]);
  });
  it('preserves modification time and revision for a repeated identical choice', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    vi.mocked(Date.now).mockReturnValue(now + 60000);
    expect(await service.set({ ...observed, displayTitle: 'Metadata changed' }, { watched: true }, saved.mark.revision, 0)).toEqual(saved);
  });
  it('sorts by explicit changes rather than metadata reads', async () => {
    await service.set(observed, { watched: true }, 0, 0);
    vi.mocked(Date.now).mockReturnValue(now + 1000);
    const second = { ...observed, ref: { ...observed.ref, titleId: '1002' }, displayTitle: 'Fixture New' };
    await service.set(second, { watched: true }, 0, 0);
    await service.get([observed.ref]);
    expect((await service.list()).marks.map(mark => mark.observation.displayTitle)).toEqual(['Fixture New', 'Fixture Favourite']);
  });
  it('keeps distinct Netflix IDs separate even when names match', async () => {
    await service.set(observed, { watched: true }, 0, 0);
    const remake = { ...observed, ref: { ...observed.ref, titleId: '1002' } };
    await service.set(remake, { plan: 'pass' }, 0, 0);
    expect((await service.list()).marks).toHaveLength(2);
  });
  it('consumes a clear action as a revision tombstone without listing an empty choice', async () => {
    const saved = await service.set(observed, { plan: 'want' }, 0, 0);
    const cleared = await service.set(observed, { watched: false, plan: 'none' }, saved.mark.revision, 0);
    expect(await service.list()).toEqual({ marks: [], epoch: 0 });
    expect((await service.get([observed.ref])).marks).toEqual([cleared.mark]);
    await expect(service.set(observed, { watched: true }, saved.mark.revision, 0)).rejects.toThrow('changed elsewhere');
  });
  it('only allows one of two simultaneous writers with the same revision', async () => {
    const results = await Promise.allSettled([service.set(observed, { watched: true }, 0, 0), service.set(observed, { plan: 'pass' }, 0, 0)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await service.get([observed.ref])).marks[0].revision).toBe(1);
  });
});

describe('revision-safe Undo and reset', () => {
  it('restores the exact prior seen/plan fields with a new revision', async () => {
    const first = await service.set(observed, { watched: true, plan: 'want' }, 0, 0);
    const changed = await service.set(observed, { watched: false, plan: 'pass' }, first.mark.revision, 0);
    const restored = await service.undo(observed.ref, changed.mark.operationId, changed.mark.revision, 0);
    expect(restored.mark).toMatchObject({ watched: true, plan: 'want', revision: 3 });
    expect(restored.mark.operationId).not.toBe(changed.mark.operationId);
  });
  it('undoing a first watched mark removes the fact completely', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    const restored = await service.undo(observed.ref, saved.mark.operationId, saved.mark.revision, 0);
    expect(hasMarks(restored.mark)).toBe(false);
    expect(await service.list()).toEqual({ marks: [], epoch: 0 });
    expect(JSON.stringify(restored.mark)).not.toMatch(/watchedAt|history|undo/);
  });
  it('rejects old Undo after another tab changes the choice', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    await service.set(observed, { plan: 'want' }, saved.mark.revision, 0);
    await expect(service.undo(observed.ref, saved.mark.operationId, saved.mark.revision, 0)).rejects.toThrow('newer choice');
    expect((await service.list()).marks[0]).toMatchObject({ watched: true, plan: 'want' });
  });
  it('rejects a fabricated operation ID and repeated Undo', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    await expect(service.undo(observed.ref, crypto.randomUUID(), saved.mark.revision, 0)).rejects.toThrow('newer choice');
    await service.undo(observed.ref, saved.mark.operationId, saved.mark.revision, 0);
    await expect(service.undo(observed.ref, saved.mark.operationId, saved.mark.revision, 0)).rejects.toThrow('newer choice');
  });
  it('expires only short Undo metadata, never the actual mark', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    vi.mocked(Date.now).mockReturnValue(now + MARK_UNDO_MS + 1);
    await expect(service.undo(observed.ref, saved.mark.operationId, saved.mark.revision, 0)).rejects.toThrow('expired');
    expect((await service.list()).marks).toEqual([saved.mark]);
  });
  it('retains usable Undo after a worker restart', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    (await repo.open()).close();
    const reopened = new Repository(databaseName);
    try {
      expect(hasMarks((await new MarksService(reopened).undo(observed.ref, saved.mark.operationId, saved.mark.revision, 0)).mark)).toBe(false);
    } finally { (await reopened.open()).close(); }
  });
  it('reset invalidates old writes, old Undo and first writes to previously absent titles', async () => {
    const saved = await service.set(observed, { watched: true }, 0, 0);
    await service.reset();
    expect(await service.list()).toEqual({ marks: [], epoch: 1 });
    await expect(service.undo(observed.ref, saved.mark.operationId, saved.mark.revision, 0)).rejects.toThrow('newer choice');
    await expect(service.set(observed, { plan: 'want' }, 0, 0)).rejects.toThrow('changed elsewhere');
    await expect(service.set({ ...observed, ref: { ...observed.ref, titleId: '1002' } }, { watched: true }, 0, 0)).rejects.toThrow('changed elsewhere');
    expect((await service.set(observed, { plan: 'want' }, 0, 1)).mark.plan).toBe('want');
  });
  it('reset preserves unrelated ratings, key/config state and request protections', async () => {
    await repo.put('ratings', 'fixture', { score: 7.5 });
    await repo.put('state', 'mappingEpoch', 9); await repo.put('state', 'fixtureCircuit', { until: now + 5000 });
    await repo.put('attempts', 'fixture', { at: now });
    await repo.put('mappings', 'fixture', { subject: { id: 'tt1234567' } });
    await service.set(observed, { watched: true }, 0, 0); await service.reset();
    expect(await repo.get('ratings', 'fixture')).toEqual({ score: 7.5 });
    expect(await repo.get('state', 'mappingEpoch')).toBe(9);
    expect(await repo.get('state', 'fixtureCircuit')).toEqual({ until: now + 5000 });
    expect(await repo.get('attempts', 'fixture')).toEqual({ at: now });
    expect(await repo.get('mappings', 'fixture')).toEqual({ subject: { id: 'tt1234567' } });
  });
});

describe('bounded requests and public export', () => {
  it('exports only active user choices and no inverse-operation metadata', async () => {
    const saved = await service.set(observed, { watched: true, plan: 'want' }, 0, 0);
    const result = await service.export();
    expect(result).toEqual({ marks: [saved.mark], epoch: 0 });
    expect(JSON.stringify(result)).not.toMatch(/undo|until|credential|apikey|history/);
    expect(await repo.get('marks', titleKey(observed.ref))).toHaveProperty('undo');
  });
  it('rejects oversized/foreign reference batches and invalid mutations', async () => {
    await expect(service.get(Array.from({ length: 101 }, () => observed.ref))).rejects.toThrow('Invalid');
    await expect(service.get([{ platformId: 'foreign', titleId: '1001' }])).rejects.toThrow('Invalid');
    await expect(service.set(observed, {}, 0, 0)).rejects.toThrow('Invalid');
    await expect(service.set(observed, { watched: true }, -1, 0)).rejects.toThrow('Invalid');
    await expect(service.set(observed, { watched: true }, 0, -1)).rejects.toThrow('Invalid');
    await expect(service.set({ ...observed, displayTitle: '' }, { watched: true }, 0, 0)).rejects.toThrow('Invalid');
  });
  it('provides plain-language labels without implying that seen titles cannot be rewatched', () => {
    expect(markLabel({ watched: false, plan: 'none' })).toBe('No marks');
    expect(markLabel({ watched: true, plan: 'want' })).toBe('Watched · Want to watch');
    expect(markLabel({ watched: true, plan: 'pass' })).toBe('Watched · Won’t watch');
  });
});
