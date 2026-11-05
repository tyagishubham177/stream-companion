import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/background/repository';
import { parseWikidataResponse, WikidataResolver, type DirectIdResult } from '../../src/providers/wikidata';

const now = Date.UTC(2026, 10, 5, 8);
const ref = (titleId = '70136129') => ({ platformId: 'netflix', titleId });
const eligibility = async () => ({ enabled: true, cacheOnly: false });
const repository = () => new Repository(`wikidata-${crypto.randomUUID()}`);
const cacheKey = (id = '70136129') => JSON.stringify(['wikidata', 'netflix', id]);
function binding(netflixId = '70136129', imdbId = 'tt0758790', entity = 'Q326731') {
  return { netflixId: { type: 'literal', value: netflixId }, imdbId: { type: 'literal', value: imdbId },
    item: { type: 'uri', value: `http://www.wikidata.org/entity/${entity}` } };
}
function response(bindings: unknown[] = [binding()]) {
  return { head: { vars: ['netflixId', 'item', 'imdbId'] }, results: { bindings } };
}
function requestIds(input: Parameters<typeof fetch>[0]): string[] {
  return [...new URL(String(input)).searchParams.get('query')!.matchAll(/"(\d+)"/g)].map(match => match[1]);
}
function dynamicResponse(input: Parameters<typeof fetch>[0]): Response {
  return new Response(JSON.stringify(response(requestIds(input).map(id => binding(id)))));
}
beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('complete direct-ID response validation', () => {
  it('returns a unique IMDb identity and bounded Wikidata provenance', () => {
    expect(parseWikidataResponse(response(), ['70136129'], now).get('70136129'))
      .toEqual({ kind: 'matched', imdbId: 'tt0758790', entityIds: ['Q326731'], checkedAt: now });
  });
  it('collapses duplicate bindings and preserves multiple entities for one IMDb identity', () => {
    expect(parseWikidataResponse(response([binding(), binding(), binding('70136129', 'tt0758790', 'Q42')]), ['70136129'], now).get('70136129'))
      .toMatchObject({ kind: 'matched', entityIds: ['Q326731', 'Q42'] });
  });
  it('marks all different IMDb IDs as ambiguous, regardless of row order', () => {
    expect(parseWikidataResponse(response([binding(), binding('70136129', 'tt1234567', 'Q42')]), ['70136129'], now).get('70136129'))
      .toEqual({ kind: 'ambiguous' });
  });
  it('returns a genuine missing result for an absent requested ID', () => {
    const result = parseWikidataResponse(response(), ['70136129', '70136117'], now);
    expect(result.get('70136117')).toEqual({ kind: 'missing' });
    expect(result.size).toBe(2);
  });
  it.each([
    { head: { vars: ['wrong'] }, results: { bindings: [] } },
    { head: { vars: ['netflixId', 'item', 'imdbId'] }, results: { bindings: {} } },
    { ...response(), truncated: true },
    { ...response(), partial: true },
    { ...response(), warning: 'partial results' },
    { head: { vars: ['netflixId', 'item', 'imdbId'] }, results: { bindings: [], truncated: true } },
    response([binding('999')]),
    response([binding('70136129', 'nm1234567')]),
    response([binding('70136129', 'tt123')]),
    response([binding('70136129', 'tt0758790', 'Q0')]),
    response([{ ...binding(), item: { type: 'uri', value: 'https://evil.test/entity/Q42' } }]),
    response([{ ...binding(), netflixId: { type: 'uri', value: '70136129' } }]),
    response([{ ...binding(), imdbId: { type: 'literal', value: 'tt0758790', 'xml:lang': 'en' } }]),
    response([{ ...binding(), surprise: { value: 'unrequested column' } }]),
  ])('rejects malformed, foreign or explicitly incomplete data %#', raw => {
    expect(() => parseWikidataResponse(raw, ['70136129'], now)).toThrow();
  });
  it('does not turn a malformed competing row into an accepted unique identity', () => {
    expect(() => parseWikidataResponse(response([binding(), binding('70136129', 'not-an-id', 'Q42')]), ['70136129'], now)).toThrow();
  });
  it('rejects oversized binding sets and invalid query identifiers', () => {
    expect(() => parseWikidataResponse(response(Array.from({ length: 1001 }, () => binding())), ['70136129'], now)).toThrow();
    expect(() => parseWikidataResponse(response(), ['1" } SERVICE <https://evil.test>'], now)).toThrow();
  });
});

describe('visible-demand batching and source caching', () => {
  it('coalesces IDs in a fixed-origin request and never includes credentials', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const resolver = new WikidataResolver(repo, eligibility, fetcher);
    const values = await Promise.all([resolver.resolve(ref(), () => true), resolver.resolve(ref('70136117'), () => true), resolver.resolve(ref(), () => true)]);
    expect(values.every(value => value.kind === 'matched')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0]; const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe('https://query.wikidata.org/sparql');
    expect(requestIds(input).sort()).toEqual(['70136117', '70136129']);
    expect(url.searchParams.has('apikey')).toBe(false);
    expect(url.searchParams.get('query')).not.toMatch(/LIMIT|SERVICE/i);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect((init?.headers as Record<string, string>)['Api-User-Agent']).toContain('StreamCompanion');
    expect(await repo.all('attempts')).toHaveLength(0);
  });
  it('keeps a surviving duplicate consumer after another loses demand', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const resolver = new WikidataResolver(repository(), eligibility, fetcher);
    let active = true;
    const demand = vi.fn(() => active);
    const first = resolver.resolve(ref(), demand);
    await vi.waitFor(() => expect(demand).toHaveBeenCalled(), { interval: 5 });
    let joined!: () => void;
    const attached = new Promise<void>(resolve => { joined = resolve; });
    const second = resolver.resolve(ref(), () => { joined(); return true; });
    // resolve() reads IndexedDB before registering demand. Wait for attachment
    // (or an already completed cached result) before cancelling the first consumer.
    await Promise.race([attached, second]);
    active = false;
    expect((await first).kind).toBe('matched');
    expect((await second).kind).toBe('matched');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('drops cancelled demand before a queued batch is sent', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const resolver = new WikidataResolver(repo, eligibility, fetcher);
    let active = true; const demand = vi.fn(() => active);
    const result = resolver.resolve(ref(), demand);
    await vi.waitFor(() => expect(demand).toHaveBeenCalled(), { interval: 5 }); active = false;
    expect(await result).toMatchObject({ kind: 'deferred', reason: 'busy' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.get('state', 'wikidata:transport')).toBeUndefined();
  });
  it('settles a queued job if its demand callback becomes unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const resolver = new WikidataResolver(repository(), eligibility, fetcher);
    let checks = 0;
    const result = await resolver.resolve(ref(), () => {
      if (++checks > 1) throw new Error('document state lost');
      return true;
    });
    expect(result).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('splits batches at twenty and spaces dispatches by at least one second', async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async input => { starts.push(Date.now()); return dynamicResponse(input); });
    const resolver = new WikidataResolver(repository(), eligibility, fetcher);
    const results = await Promise.all(Array.from({ length: 21 }, (_, i) => resolver.resolve(ref(String(1000 + i)), () => true)));
    expect(results.every(value => value.kind === 'matched')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestIds(fetcher.mock.calls[0][0])).toHaveLength(20);
    expect(requestIds(fetcher.mock.calls[1][0])).toHaveLength(1);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
  });
  it('bounds pending titles at one hundred', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const resolver = new WikidataResolver(repository(), eligibility, fetcher);
    const pending = Array.from({ length: 101 }, (_, i) => resolver.resolve(ref(String(2000 + i)), () => true));
    const results = await Promise.all(pending);
    expect(results.filter(value => value.kind === 'matched')).toHaveLength(100);
    expect(results.filter(value => value.kind === 'deferred')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(5);
  }, 10000);
  it('returns source cache before disabled/cache-only eligibility and across instances', async () => {
    const repo = repository();
    await repo.put('resolutions', cacheKey(), { expiresAt: Date.now() + 10000,
      result: { kind: 'matched', imdbId: 'tt0758790', entityIds: ['Q326731'], checkedAt: Date.now() } });
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const disabled = async () => ({ enabled: false, cacheOnly: true });
    expect((await new WikidataResolver(repo, disabled, fetcher).resolve(ref(), () => false)).kind).toBe('matched');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('stores positive identities for thirty days, without touching OMDb accounting', async () => {
    const repo = repository(); const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const before = Date.now();
    const value = await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true);
    const cached = await repo.get<{ expiresAt: number; result: DirectIdResult }>('resolutions', cacheKey());
    expect(value.kind).toBe('matched'); expect(cached?.result).toEqual(value);
    expect(cached!.expiresAt - before).toBeGreaterThanOrEqual(30 * 86400000);
    await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await repo.all('attempts')).toHaveLength(0);
  });
  it.each(['missing', 'ambiguous'] as const)('stores an actual %s result for twenty-four hours', async kind => {
    const repo = repository(); const before = Date.now();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response(kind === 'missing' ? [] : [binding(), binding('70136129', 'tt1234567', 'Q42')]))));
    expect(await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).toEqual({ kind });
    const cached = await repo.get<{ expiresAt: number }>('resolutions', cacheKey());
    expect(cached!.expiresAt - before).toBeGreaterThanOrEqual(86400000);
    expect(cached!.expiresAt - before).toBeLessThan(86400000 + 5000);
  });
  it('does not fetch for disabled settings, cache-only, offline or unsupported platforms', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const repo = repository();
    expect(await new WikidataResolver(repo, eligibility, fetcher).resolve({ platformId: 'future', titleId: '123' }, () => true)).toEqual({ kind: 'missing' });
    await new WikidataResolver(repo, async () => ({ enabled: false, cacheOnly: false }), fetcher).resolve(ref(), () => true);
    await new WikidataResolver(repo, async () => ({ enabled: true, cacheOnly: true }), fetcher).resolve(ref(), () => true);
    vi.stubGlobal('navigator', { onLine: false });
    expect(await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', reason: 'offline' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rechecks settings after reservation and releases a cancelled lease', async () => {
    const repo = repository(); let checks = 0;
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    const resolver = new WikidataResolver(repo, async () => ({ enabled: true, cacheOnly: ++checks >= 3 }), fetcher);
    expect(await resolver.resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', reason: 'busy' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.get('state', 'wikidata:transport')).toMatchObject({ leaseUntil: 0, failures: 0, cooldownUntil: 0 });
  });
});

describe('durable service failures and recovery', () => {
  it('claims only one shared lease across resolver instances', async () => {
    const repo = repository(); let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
    const a = new WikidataResolver(repo, eligibility, fetcher), b = new WikidataResolver(repo, eligibility, fetcher);
    const first = a.resolve(ref(), () => true), second = b.resolve(ref(), () => true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(await Promise.race([first, second])).toMatchObject({ kind: 'deferred', reason: 'busy' });
    release(new Response(JSON.stringify(response())));
    expect((await Promise.all([first, second])).filter(value => value.kind === 'matched')).toHaveLength(1);
  });
  it('persists Retry-After cooldown across restarts and never caches throttling as missing', async () => {
    const repo = repository(); const before = Date.now();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 429, headers: { 'Retry-After': '3600' } }));
    expect(await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true))
      .toMatchObject({ kind: 'deferred', reason: 'provider', retryAfter: expect.any(Number) });
    const state = await repo.get<{ cooldownUntil: number }>('state', 'wikidata:transport');
    expect(state!.cooldownUntil).toBeGreaterThanOrEqual(before + 3600000);
    expect(await new WikidataResolver(repo, eligibility, fetcher).resolve(ref('70136117'), () => true))
      .toMatchObject({ kind: 'deferred', reason: 'provider', message: expect.stringContaining('cooling down') });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await repo.all('resolutions')).toHaveLength(0);
  });
  it.each([
    () => new Response('{bad json'),
    () => new Response('x'.repeat(262145)),
    () => new Response(JSON.stringify(response([binding('999')]))),
    () => new Response(JSON.stringify({ ...response(), truncated: true })),
    () => new Response(JSON.stringify(response()), { status: 206 }),
    () => new Response('', { status: 503 }),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('test-only private detail')); } })),
  ])('keeps invalid or temporary provider failures out of the negative cache %#', async factory => {
    const repo = repository(); const fetcher = vi.fn<typeof fetch>(async () => factory());
    const result = await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true);
    expect(result).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(await repo.all('resolutions')).toHaveLength(0);
    expect(await repo.get('state', 'wikidata:transport')).toMatchObject({ failures: 1, leaseUntil: 0 });
    expect(JSON.stringify(result)).not.toContain('test-only private detail');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('fails closed when the pre-dispatch storage reservation fails', async () => {
    const repo = repository(); vi.spyOn(repo, 'transaction').mockRejectedValue(new Error('disk full'));
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    expect(await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true))
      .toMatchObject({ kind: 'deferred', reason: 'provider', message: expect.stringContaining('local storage') });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('can resume after a persisted expired lease from worker loss', async () => {
    const repo = repository();
    await repo.put('state', 'wikidata:transport', { leaseId: 'lost', leaseUntil: Date.now() - 1, failures: 0, cooldownUntil: 0, nextDispatchAt: 0, lastClock: Date.now() });
    const fetcher = vi.fn<typeof fetch>(async input => dynamicResponse(input));
    expect((await new WikidataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).kind).toBe('matched');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
