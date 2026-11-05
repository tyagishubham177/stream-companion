import { afterEach, describe, expect, it, vi } from 'vitest';
import { Configuration } from '../../src/background/config';
import { DEFAULT_SETTINGS } from '../../src/shared/contracts';

function fixture() {
  const stored: Record<string, unknown> = {};
  let beforeSet: ((changes: Record<string, unknown>) => Promise<void>) | undefined;
  const local = {
    setAccessLevel: vi.fn(async () => undefined),
    get: vi.fn(async () => structuredClone(stored)),
    set: vi.fn(async (changes: Record<string, unknown>) => {
      await beforeSet?.(changes);
      Object.assign(stored, structuredClone(changes));
    }),
  };
  const session = { setAccessLevel: vi.fn(async () => undefined) };
  vi.stubGlobal('chrome', { storage: { local, session } });
  return { config: new Configuration(), stored, local, session, interceptSet: (callback: typeof beforeSet) => { beforeSet = callback; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('trusted configuration persistence and concurrent edits', () => {
  it('restricts both storage areas before loading settings or credentials', async () => {
    const { config, local, session } = fixture();
    await config.ready();
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(local.setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(local.get.mock.invocationCallOrder[0]);
    expect(session.setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(local.get.mock.invocationCallOrder[0]);
    expect(await config.settings()).toEqual(DEFAULT_SETTINGS);
    expect(await config.credential()).toBeUndefined();
  });

  it('preserves independent concurrent preference edits and exposes only committed state', async () => {
    const { config, stored, local, interceptSet } = fixture();
    await config.ready();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    interceptSet(async () => { if (++writes === 1) await gate; });
    const disable = config.update({ enabled: false });
    const move = config.update({ corner: 'top-left' });
    await vi.waitFor(() => expect(local.set).toHaveBeenCalledTimes(1));
    expect(await config.settings()).toEqual(DEFAULT_SETTINGS);
    release();
    await Promise.all([disable, move]);
    expect(await config.settings()).toEqual({ enabled: false, cacheOnly: false, corner: 'top-left' });
    expect(stored.settings).toEqual(await config.settings());
  });

  it('serializes concurrent keys into distinct versions and reuses a key identity after removal', async () => {
    const { config, local, stored } = fixture();
    await Promise.all([config.setKey('synthetic-key-a'), config.setKey('synthetic-key-b')]);
    const credentials = local.set.mock.calls.map(([change]) => change.credential as { key: string; version: number });
    expect(credentials.map(value => value.version)).toEqual([1, 2]);
    const active = await config.credential();
    expect(active).toMatchObject({ key: 'synthetic-key-b', version: 2 });
    expect(stored.credential).toEqual({ key: 'synthetic-key-b', version: 2 });
    await config.setKey('');
    expect(await config.credential()).toBeUndefined();
    await config.setKey('synthetic-key-b');
    expect(await config.credential()).toMatchObject({ id: active!.id, version: 4 });
  });

  it('reports failed persistence, retains committed values, and accepts subsequent edits', async () => {
    const { config, interceptSet } = fixture();
    await config.setKey('synthetic-key-a');
    const original = await config.credential();
    let fail = true;
    interceptSet(async () => { if (fail) { fail = false; throw new Error('Synthetic storage failure'); } });
    await expect(config.setKey('synthetic-key-b')).rejects.toThrow('Synthetic storage failure');
    expect(await config.credential()).toEqual(original);
    await config.update({ cacheOnly: true });
    expect(await config.settings()).toEqual({ ...DEFAULT_SETTINGS, cacheOnly: true });
    expect(await config.credential()).toEqual(original);
    await config.setKey('synthetic-key-b');
    expect(await config.credential()).toMatchObject({ key: 'synthetic-key-b', version: 2 });
  });
});
