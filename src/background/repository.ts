import { SCHEMA_VERSION } from '../shared/contracts';

export const STORES = ['mappings', 'ratings', 'resolutions', 'contexts', 'state', 'attempts', 'leases', 'matchingLogs', 'marks'] as const;
export type Store = typeof STORES[number];
interface Entry<T> { key: string; value: T }
export const idbRequest = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Local storage request failed.'));
});

export class Repository {
  private database?: Promise<IDBDatabase>;
  constructor(private readonly name = 'stream-companion') {}
  open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'key' });
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(new Error('Local storage could not be opened.'));
      request.onblocked = () => reject(new Error('Close other extension pages to finish the storage upgrade.'));
    });
  }
  async transaction<T>(stores: Store[], work: (tx: IDBTransaction) => Promise<T>, strict = false): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(stores, 'readwrite', { durability: strict ? 'strict' : 'default' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('Local storage transaction failed.'));
    });
    try { const result = await work(tx); await done; return result; }
    catch (error) {
      try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
  }
  async get<T>(store: Store, key: string): Promise<T | undefined> {
    const db = await this.open();
    return (await idbRequest(db.transaction(store).objectStore(store).get(key)) as Entry<T> | undefined)?.value;
  }
  async all<T>(store: Store): Promise<Array<Entry<T>>> {
    const db = await this.open();
    return await idbRequest(db.transaction(store).objectStore(store).getAll()) as Array<Entry<T>>;
  }
  async put<T>(store: Store, key: string, value: T): Promise<void> {
    await this.transaction([store], async tx => { await idbRequest(tx.objectStore(store).put({ key, value })); });
  }
  async clear(store: Store): Promise<void> {
    await this.transaction([store], async tx => { await idbRequest(tx.objectStore(store).clear()); });
  }
  async delete(store: Store, key: string): Promise<void> {
    await this.transaction([store], async tx => { await idbRequest(tx.objectStore(store).delete(key)); });
  }
  async prune(now: number): Promise<void> {
    await this.transaction(['resolutions', 'contexts', 'ratings'], async tx => {
      for (const name of ['resolutions', 'contexts'] as const) {
        const records = await idbRequest(tx.objectStore(name).getAll()) as Entry<{ expiresAt: number }>[];
        records.sort((a, b) => b.value.expiresAt - a.value.expiresAt);
        const limit = name === 'contexts' ? 100 : 2000;
        for (let i = 0; i < records.length; i++) if (records[i].value.expiresAt < now || i >= limit) tx.objectStore(name).delete(records[i].key);
      }
      const ratings = await idbRequest(tx.objectStore('ratings').getAll()) as Entry<{ fetchedAt: number }>[];
      ratings.sort((a, b) => b.value.fetchedAt - a.value.fetchedAt);
      for (const entry of ratings.slice(2000)) tx.objectStore('ratings').delete(entry.key);
    });
  }
}

export async function txGet<T>(tx: IDBTransaction, store: Store, key: string): Promise<T | undefined> {
  return (await idbRequest(tx.objectStore(store).get(key)) as Entry<T> | undefined)?.value;
}
export function txPut(tx: IDBTransaction, store: Store, key: string, value: unknown): void {
  tx.objectStore(store).put({ key, value });
}
