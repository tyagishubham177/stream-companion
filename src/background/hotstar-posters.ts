import { HOTSTAR_POSTER_CAPACITY, type HotstarPosterEntry, type HotstarPosterSnapshot } from '../shared/contracts';
import { validHotstarPosterEntry } from '../shared/validation';
import { mergeHotstarPosterBinding as merge } from '../shared/hotstar-poster-binding';

const STORAGE_KEY = 'hotstarPosterMemoryV1';
type Binding = HotstarPosterEntry['value'];
type Bindings = Map<string, Binding>;

function snapshot(bindings: Bindings): HotstarPosterSnapshot {
  return { entries: [...bindings].map(([key, value]) => ({ key, value })) };
}

/** This worker alone writes verified catalogue evidence after storage access is restricted. */
export class HotstarPosterMemory {
  private writes: Promise<unknown> = Promise.resolve();

  private async read(): Promise<Bindings> {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as unknown;
    const bindings: Bindings = new Map();
    if (!Array.isArray(stored)) return bindings;
    for (const entry of stored.slice(0, HOTSTAR_POSTER_CAPACITY)) {
      if (validHotstarPosterEntry(entry)) bindings.set(entry.key, merge(bindings.get(entry.key), entry.value));
    }
    return bindings;
  }

  async get(): Promise<HotstarPosterSnapshot> {
    await this.writes;
    return snapshot(await this.read());
  }

  save(entries: readonly HotstarPosterEntry[]): Promise<HotstarPosterSnapshot> {
    const write = this.writes.then(async () => {
      const bindings = await this.read();
      const affected: Bindings = new Map();
      let changed = false;
      for (const { key, value } of entries) {
        const previous = bindings.get(key);
        // Preserve the conflict marker for every accepted key, including when full.
        if (previous === undefined && bindings.size >= HOTSTAR_POSTER_CAPACITY) continue;
        const merged = merge(previous, value);
        if (merged !== previous) { bindings.set(key, merged); changed = true; }
        affected.set(key, merged);
      }
      if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: snapshot(bindings).entries });
      return snapshot(affected);
    });
    this.writes = write.catch(() => undefined); // An unsuccessful write must not block later requests.
    return write;
  }
}
