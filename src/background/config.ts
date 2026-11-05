import { DEFAULT_SETTINGS, type Settings } from '../shared/contracts';
import type { Credential } from './scheduler';

export class Configuration {
  private loaded?: Promise<void>;
  private active?: Credential;
  private preferences: Settings = { ...DEFAULT_SETTINGS };
  private version = 0;
  private mutations: Promise<void> = Promise.resolve();
  private serialize(work: () => Promise<void>): Promise<void> {
    const result = this.mutations.then(work);
    this.mutations = result.catch(() => undefined); // The caller still receives the error; later edits remain possible.
    return result;
  }
  ready(): Promise<void> {
    return this.loaded ??= this.load();
  }
  private async load(): Promise<void> {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const value = await chrome.storage.local.get(['settings', 'credential']);
    const raw = value.settings as Partial<Settings> | undefined;
    if (raw) this.preferences = { enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      corner: raw.corner === 'top-left' ? 'top-left' : 'top-right', cacheOnly: raw.cacheOnly === true };
    const saved = value.credential as { key?: string; version?: number } | undefined;
    this.version = saved?.version ?? 0;
    if (saved?.key) this.active = await this.make(saved.key, this.version);
  }
  private async make(key: string, version: number): Promise<Credential> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return { key, version, id: Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('') };
  }
  async credential(): Promise<Credential | undefined> { await this.ready(); return this.active; }
  async settings(): Promise<Settings> { await this.ready(); return { ...this.preferences }; }
  async setKey(key: string): Promise<void> {
    return this.serialize(async () => {
      await this.ready();
      const version = this.version + 1;
      const next = key ? await this.make(key, version) : undefined;
      await chrome.storage.local.set({ credential: { key, version } });
      this.version = version; this.active = next;
    });
  }
  async update(settings: Partial<Settings>): Promise<void> {
    return this.serialize(async () => {
      await this.ready();
      const next = { ...this.preferences, ...settings };
      await chrome.storage.local.set({ settings: next }); this.preferences = next;
    });
  }
}
