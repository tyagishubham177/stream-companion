import { afterEach, describe, expect, it, vi } from 'vitest';
import { HotstarPosterMemory } from '../../src/background/hotstar-posters';
import { HOTSTAR_POSTER_BATCH_SIZE, HOTSTAR_POSTER_CAPACITY, PROTOCOL_VERSION, type HotstarPosterBinding, type HotstarPosterEntry } from '../../src/shared/contracts';
import { authoriseRequest, validHotstarPosterEntry, validateRequest } from '../../src/shared/validation';

const storageKey = 'hotstarPosterMemoryV1';
const fixtureBinding = (titleId = '1234', metadata: HotstarPosterBinding['metadata'] = {}): HotstarPosterBinding => ({
  work: { titleId, pagePath: '/in/movies/fixture/' + titleId, mediaType: 'movie' },
  metadata,
});
const key = (index = 1, type = 'movie') => JSON.stringify([`6175${index}-v`, 'fixture film', type]);
const entry = (index = 1, value: HotstarPosterEntry['value'] = fixtureBinding()): HotstarPosterEntry => ({ key: key(index), value });

function fixture(initial?: unknown) {
  const stored: Record<string, unknown> = { [storageKey]: initial, unrelatedSettings: { enabled: true } };
  let beforeSet: (() => Promise<void>) | undefined;
  const get = vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) }));
  const set = vi.fn(async (changes: Record<string, unknown>) => {
    await beforeSet?.();
    Object.assign(stored, structuredClone(changes));
  });
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  return { memory: new HotstarPosterMemory(), get, set, stored, interceptWrite: (fn: typeof beforeSet) => { beforeSet = fn; } };
}
afterEach(() => vi.unstubAllGlobals());

describe('durable Hotstar poster identity memory', () => {
  it('hydrates a fresh worker from the dedicated key and avoids writes on repeated observations', async () => {
    const { memory, get, set, stored } = fixture();
    expect(await memory.get()).toEqual({ entries: [] });
    expect(await memory.save([entry()])).toEqual({ entries: [entry()] });
    const restarted = new HotstarPosterMemory();
    expect(await restarted.get()).toEqual({ entries: [entry()] });
    const alternateSlug = fixtureBinding();
    alternateSlug.work.pagePath = '/in/movies/other-valid-slug/1234';
    expect(await restarted.save([entry(1, alternateSlug)])).toEqual({ entries: [entry()] });
    expect(set).toHaveBeenCalledExactlyOnceWith({ [storageKey]: [entry()] });
    expect(get.mock.calls.every(call => call[0] === storageKey)).toBe(true);
    expect(stored.unrelatedSettings).toEqual({ enabled: true });
  });

  it('serializes concurrent saves, merging distinct keys and permanently tombstoning conflicting IDs', async () => {
    const { memory, set, interceptWrite } = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    interceptWrite(() => gate);
    const first = memory.save([entry(1), entry(2)]);
    const second = memory.save([entry(1, fixtureBinding('9876')), entry(3)]);
    const afterPending = memory.get();
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual({ entries: [entry(1), entry(2)] });
    expect(await second).toEqual({ entries: [entry(1, null), entry(3)] });
    expect(await afterPending).toEqual({ entries: [entry(1, null), entry(2), entry(3)] });
    expect(await memory.save([entry(1)])).toEqual({ entries: [entry(1, null)] });
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('adds verified metadata later and discards contradictory metadata without losing work identity', async () => {
    const { memory, set } = fixture([entry()]);
    await memory.save([entry(1, fixtureBinding('1234', { year: 2024 }))]);
    expect(await memory.save([entry()])).toEqual({ entries: [entry(1, fixtureBinding('1234', { year: 2024 }))] });
    expect(await memory.save([entry(1, fixtureBinding('1234', { year: 2025 }))])).toEqual({ entries: [entry(1, fixtureBinding('1234', null))] });
    expect(await memory.save([entry(1, fixtureBinding('1234', { year: 2024 }))])).toEqual({ entries: [entry(1, fixtureBinding('1234', null))] });
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('preserves existing entries and conflict markers when at capacity', async () => {
    const { memory, set } = fixture(Array.from({ length: HOTSTAR_POSTER_CAPACITY }, (_, index) => entry(index, index === 0 ? null : fixtureBinding())));
    expect(await memory.save([entry(HOTSTAR_POSTER_CAPACITY), entry(0)])).toEqual({ entries: [entry(0, null)] });
    expect(set).not.toHaveBeenCalled();
    expect(await memory.save([entry(1, fixtureBinding('9876'))])).toEqual({ entries: [entry(1, null)] });
    const read = await memory.get();
    expect(read.entries).toHaveLength(HOTSTAR_POSTER_CAPACITY);
    expect(read.entries.slice(0, 2)).toEqual([entry(0, null), entry(1, null)]);
  });

  it('releases the write queue after a failed storage write', async () => {
    const { memory, set } = fixture([entry(1)]);
    set.mockRejectedValueOnce(new Error('Synthetic write failure'));
    const failed = memory.save([entry(2)]);
    const next = memory.save([entry(3)]);
    await expect(failed).rejects.toThrow('Synthetic write failure');
    await expect(next).resolves.toEqual({ entries: [entry(3)] });
    await expect(memory.get()).resolves.toEqual({ entries: [entry(1), entry(3)] });
  });

  it('validates persisted entries and does not expose malformed data or resurrect duplicate conflicts', async () => {
    const invalid = { ...entry(2), value: { ...fixtureBinding(), tracking: 'fixture' } };
    const { memory, set } = fixture([entry(1), invalid, entry(1, fixtureBinding('9876')), entry(1)]);
    expect(await memory.get()).toEqual({ entries: [entry(1, null)] });
    expect(set).not.toHaveBeenCalled();
  });
});

describe('Hotstar poster request boundaries', () => {
  const sender = (url: string, overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({
    id: 'ext', url, frameId: 0, documentId: 'fixture', tab: { id: 5, incognito: false } as chrome.tabs.Tab, ...overrides,
  });
  const supported = 'https://www.hotstar.com/in/shows';
  const request = (type: string, extra = {}) => validateRequest({ protocol: PROTOCOL_VERSION, type, ...extra });
  it('accepts both requests only from Hotstar catalogue content', () => {
    for (const action of [request('GET_HOTSTAR_POSTERS'), request('SAVE_HOTSTAR_POSTERS', { entries: [entry()] })]) {
      expect(authoriseRequest(sender(supported), 'ext', action)).toEqual({ role: 'content', platformId: 'hotstar' });
      expect(() => authoriseRequest(sender('https://www.netflix.com/browse'), 'ext', action)).toThrow(/cannot access/);
      expect(() => authoriseRequest(sender(supported + '/fixture/1234/watch'), 'ext', action)).toThrow(/not authorised/);
      expect(() => authoriseRequest(sender(supported, { frameId: 1 }), 'ext', action)).toThrow(/not authorised/);
      expect(() => authoriseRequest(sender('chrome-extension://ext/options.html'), 'ext', action)).toThrow(/cannot perform/);
    }
  });

  it('bounds writes to twenty entries and requires a canonical basename, title and matching work path', () => {
    const entries = Array.from({ length: HOTSTAR_POSTER_BATCH_SIZE }, (_, index) => entry(index));
    expect(request('SAVE_HOTSTAR_POSTERS', { entries })).toMatchObject({ entries });
    expect(() => request('SAVE_HOTSTAR_POSTERS', { entries: [] })).toThrow(/Invalid Hotstar poster evidence/);
    expect(() => request('SAVE_HOTSTAR_POSTERS', { entries: [...entries, entry(100)] })).toThrow(/Invalid Hotstar poster evidence/);
    expect(() => request('GET_HOTSTAR_POSTERS', { entries })).toThrow(/Invalid extension message fields/);
    const value = fixtureBinding();
    for (const invalid of [
      { key: JSON.stringify(['https://img10.hotstar.com/6175-v', 'fixture film', 'movie']), value },
      { key: JSON.stringify(['6175-v?tracking=fixture', 'fixture film', 'movie']), value },
      { key: JSON.stringify(['6175-v', 'Fixture Film', 'movie']), value },
      { key: key(1, 'series'), value },
      { key: key(), value: { ...value, work: { ...value.work, titleId: '9000' } } },
      { key: key(), value: { ...value, work: { ...value.work, pagePath: value.work.pagePath + '?tracking=fixture' } } },
      { key: key(), value: { ...value, metadata: { year: 2024, seasonCount: 2 } } },
    ]) expect(() => request('SAVE_HOTSTAR_POSTERS', { entries: [invalid] })).toThrow(/Invalid Hotstar poster evidence/);
  });

  it('keeps series year and season count together, and supports explicit conflict tombstones', () => {
    const work = { titleId: '1234', pagePath: '/in/shows/fixture/1234', mediaType: 'series' };
    const seriesKey = key(1, 'series');
    expect(validHotstarPosterEntry({ key: seriesKey, value: { work, metadata: { year: 2013, seasonCount: 9 } } })).toBe(true);
    expect(validHotstarPosterEntry({ key: seriesKey, value: { work, metadata: null } })).toBe(true);
    expect(validHotstarPosterEntry({ key: seriesKey, value: null })).toBe(true);
    for (const metadata of [{ year: 2013 }, { seasonCount: 9 }, { year: 2013, seasonCount: 201 }, { year: '2013', seasonCount: 9 }])
      expect(validHotstarPosterEntry({ key: seriesKey, value: { work, metadata } })).toBe(false);
  });
});
