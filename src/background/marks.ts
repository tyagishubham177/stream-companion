import { titleKey, type PlatformTitleRef, type TitleObservation } from '../shared/contracts';
import { hasMarks, type MarkMutation, type MarkPatch, type MarksSnapshot, type TitleMark } from '../shared/marks';
import { validObservation, validRef } from '../shared/validation';
import { Repository, idbRequest, txGet, txPut } from './repository';

export const MARK_UNDO_MS = 30000;
interface StoredMark extends TitleMark {
  undo?: { watched: boolean; plan: TitleMark['plan']; until: number };
}
export class MarkError extends Error {}
function publicMark(mark: StoredMark): TitleMark {
  return { observation: mark.observation, watched: mark.watched, plan: mark.plan,
    changedAt: mark.changedAt, revision: mark.revision, operationId: mark.operationId };
}
function validVersion(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
export class MarksService {
  constructor(private readonly repo: Repository) {}
  async get(refs: PlatformTitleRef[]): Promise<MarksSnapshot> {
    if (!Array.isArray(refs) || refs.length > 100 || !refs.every(validRef)) throw new MarkError('Invalid title marks request.');
    return this.repo.transaction(['marks', 'state'], async tx => {
      const marks = await Promise.all([...new Map(refs.map(ref => [titleKey(ref), ref])).keys()]
        .map(key => txGet<StoredMark>(tx, 'marks', key)));
      return { marks: marks.filter((mark): mark is StoredMark => !!mark).map(publicMark),
        epoch: await txGet<number>(tx, 'state', 'marksEpoch') ?? 0 };
    });
  }
  async list(): Promise<MarksSnapshot> {
    return this.repo.transaction(['marks', 'state'], async tx => {
      const entries = await idbRequest(tx.objectStore('marks').getAll()) as Array<{ key: string; value: StoredMark }>;
      return { marks: entries.map(entry => publicMark(entry.value)).filter(hasMarks).sort((a, b) => b.changedAt - a.changedAt),
        epoch: await txGet<number>(tx, 'state', 'marksEpoch') ?? 0 };
    });
  }
  async set(observation: TitleObservation, patch: MarkPatch, revision: number, epoch: number): Promise<MarkMutation> {
    if (!validObservation(observation) || !validVersion(revision) || !validVersion(epoch) || !patch ||
      Object.keys(patch).some(key => !['watched', 'plan'].includes(key)) || !Object.keys(patch).length ||
      (patch.watched !== undefined && typeof patch.watched !== 'boolean') ||
      (patch.plan !== undefined && !['none', 'want', 'pass'].includes(patch.plan))) throw new MarkError('Invalid title marks request.');
    return this.repo.transaction(['marks', 'state'], async tx => {
      const currentEpoch = await txGet<number>(tx, 'state', 'marksEpoch') ?? 0;
      const key = titleKey(observation.ref);
      const old = await txGet<StoredMark>(tx, 'marks', key);
      if (currentEpoch !== epoch || (old?.revision ?? 0) !== revision)
        throw new MarkError('Your marks changed elsewhere. Open the title again to edit.');
      const watched = patch.watched ?? old?.watched ?? false;
      const plan = patch.plan ?? old?.plan ?? 'none';
      if (old && watched === old.watched && plan === old.plan) return { mark: publicMark(old), epoch };
      const mark: StoredMark = { observation, watched, plan, changedAt: Date.now(), revision: revision + 1,
        operationId: crypto.randomUUID(), undo: { watched: old?.watched ?? false, plan: old?.plan ?? 'none', until: Date.now() + MARK_UNDO_MS } };
      txPut(tx, 'marks', key, mark);
      return { mark: publicMark(mark), epoch };
    }, true);
  }
  async undo(ref: PlatformTitleRef, operationId: string, revision: number, epoch: number): Promise<MarkMutation> {
    if (!validRef(ref) || !validVersion(revision) || !validVersion(epoch) || typeof operationId !== 'string' ||
      !/^[a-zA-Z0-9-]{36}$/.test(operationId)) throw new MarkError('Invalid title marks request.');
    return this.repo.transaction(['marks', 'state'], async tx => {
      const currentEpoch = await txGet<number>(tx, 'state', 'marksEpoch') ?? 0;
      const key = titleKey(ref);
      const old = await txGet<StoredMark>(tx, 'marks', key);
      if (currentEpoch !== epoch || !old || old.revision !== revision || old.operationId !== operationId)
        throw new MarkError('Your marks changed elsewhere. Undo would replace a newer choice.');
      if (!old.undo || old.undo.until < Date.now()) throw new MarkError('Undo expired. Open the title marks to change them.');
      const mark: StoredMark = { observation: old.observation, watched: old.undo.watched, plan: old.undo.plan,
        revision: old.revision + 1, changedAt: Date.now(), operationId: crypto.randomUUID() };
      // Keep an unmarked tombstone, so stale clients cannot recreate the previous choice.
      txPut(tx, 'marks', key, mark);
      return { mark: publicMark(mark), epoch };
    }, true);
  }
  async reset(): Promise<void> {
    await this.repo.transaction(['marks', 'state'], async tx => {
      txPut(tx, 'state', 'marksEpoch', (await txGet<number>(tx, 'state', 'marksEpoch') ?? 0) + 1);
      tx.objectStore('marks').clear();
    }, true);
  }
  async export(): Promise<MarksSnapshot> { return this.list(); }
}
