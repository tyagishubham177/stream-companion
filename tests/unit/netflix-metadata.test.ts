import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/background/repository';
import { NetflixMetadataResolver, parseNetflixMetadata } from '../../src/providers/netflix-metadata';

const now = Date.UTC(2026, 10, 5, 8);
const DAY = 86400000;
const ref = (titleId = '70259085') => ({ platformId: 'netflix', titleId });
const eligibility = async () => ({ enabled: true, cacheOnly: false });
const repository = () => new Repository(`netflix-metadata-${crypto.randomUUID()}`);
const cacheKey = (id = '70259085') => JSON.stringify(['netflix-metadata', 'netflix', id]);
const metadata = (name = 'English Vinglish', year = '2012') => `<div data-uia="metadata"><div><h2>${name}</h2><div><ul><li>${year}</li><li>2h</li></ul></div></div></div>`;
function page(id = '70259085', title = 'English Vinglish', year = '2012', type = 'Movie') {
  return `<html><script type="application/ld+json">${JSON.stringify({ '@type': type, name: title, url: `https://www.netflix.com/title/${id}`, dateCreated: '2026-10-19' })}</script>${metadata(title, year)}</html>`;
}
const response = (html = page()) => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('public movie metadata identity and visible release year', () => {
  it('uses the scoped visible release year, never the catalog dateCreated', () => {
    expect(parseNetflixMetadata(page(), ref().titleId, now)).toEqual({ kind: 'matched', title: 'English Vinglish', mediaType: 'movie', year: 2012, checkedAt: now });
  });
  it('works generically for other movies and entity-encoded visible headings', () => {
    const html = page('123', 'A & B', '1999').replace('<h2>A & B</h2>', '<h2>A &amp; B</h2>');
    expect(parseNetflixMetadata(html, '123', now)).toMatchObject({ title: 'A & B', year: 1999 });
  });
  it('supports JSON-LD graph and schema.org type URLs', () => {
    const html = page().replace(/<script[^>]*>.*?<\/script>/, `<script type='application/ld+json'>${JSON.stringify({ '@graph': [{ '@type': 'https://schema.org/Movie', name: 'English Vinglish', url: 'https://www.netflix.com/in/title/70259085' }] })}</script>`);
    expect(parseNetflixMetadata(html, ref().titleId, now).kind).toBe('matched');
  });
  it('ignores script and comment decoys rather than treating them as visible metadata', () => {
    const html = page().replace('<html>', `<html><!--${metadata('Wrong', '2026')}--><script>const hidden=${JSON.stringify(metadata('Wrong', '2026'))};</script>`);
    expect(parseNetflixMetadata(html, ref().titleId, now)).toMatchObject({ year: 2012 });
  });
  it('returns missing for an explicitly bound TV series, without using its latest-season year', () => {
    expect(parseNetflixMetadata(page(undefined, undefined, '2026', 'TVSeries'), ref().titleId, now)).toEqual({ kind: 'missing' });
  });
  it.each([
    page('999'),
    page().replace('https://www.netflix.com/title/', 'https://evil.test/title/'),
    page().replace('<h2>English Vinglish</h2>', '<h2>Wrong Film</h2>'),
    page().replace('</html>', `${metadata()}</html>`),
    page().replace('data-uia="metadata"', 'data-uia="metadata" data-uia="metadata"'),
    page().replace('<li>2012</li>', '<li>2h</li><li>2012</li>'),
    page().replace('<li>2012</li>', '<li>2012–2014</li>'),
    page().replace('<li>2012</li>', '<li>1870</li>'),
    page().replace('<li>2012</li>', '<li>2040</li>'),
    page().replace('<ul>', '<ul><ul>').replace('</ul>', '</ul></ul>'),
    page().replace('<h2>', '<h2>Extra</h2><h2>'),
    page().replace('</html>', '<script>unfinished'),
    page().replace('"@type":"Movie"', '"@type":"Unknown"'),
    page().replace('"name":"English Vinglish"', '"name":""'),
    page().replace('</script>', 'broken-json</script>'),
    '<html>Sign in</html>',
  ])('fails closed for missing, conflicting or malformed evidence %#', html => {
    expect(() => parseNetflixMetadata(html, ref().titleId, now)).toThrow();
  });
  it('rejects conflicting JSON-LD movie names and foreign release-header context', () => {
    const extra = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Movie', name: 'Another Film', url: 'https://www.netflix.com/title/70259085' })}</script>`;
    expect(() => parseNetflixMetadata(page() + extra, ref().titleId, now)).toThrow();
    expect(() => parseNetflixMetadata(page().replace('data-uia="metadata"', 'data-uia="other"'), ref().titleId, now)).toThrow();
  });
});

describe('public metadata transport and persistent cache', () => {
  it('coalesces demand and sends only a fixed public URL without credentials or a key', async () => {
    const repo = repository();
    const fetcher = vi.fn<typeof fetch>(async function (this: unknown) { expect(this).toBeUndefined(); return response(); });
    const resolver = new NetflixMetadataResolver(repo, eligibility, fetcher);
    const values = await Promise.all([resolver.resolve(ref(), () => true), resolver.resolve(ref(), () => true)]);
    expect(values.every(value => value.kind === 'matched')).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0];
    expect(String(input)).toBe('https://www.netflix.com/in/title/70259085');
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual' });
    expect(JSON.stringify(init)).not.toMatch(/apikey|cookie|authorization/i);
    expect(await repo.all('attempts')).toHaveLength(0);
  });
  it('reuses a positive cache for thirty days, including disabled/cache-only consumers', async () => {
    const repo = repository(), fetcher = vi.fn<typeof fetch>(async () => response()); const before = Date.now();
    const first = await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true);
    const cached = await repo.get<{ expiresAt: number }>('resolutions', cacheKey());
    expect(cached!.expiresAt - before).toBeGreaterThanOrEqual(30 * DAY);
    expect(cached!.expiresAt - before).toBeLessThan(30 * DAY + 1000);
    expect(await new NetflixMetadataResolver(repo, async () => ({ enabled: false, cacheOnly: true }), fetcher).resolve(ref(), () => false)).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([() => new Response('', { status: 404 }), () => response(page(undefined, undefined, undefined, 'TVSeries'))])('caches genuine unsupported/missing evidence for one day %#', async factory => {
    const repo = repository(), before = Date.now(); const fetcher = vi.fn<typeof fetch>(async () => factory());
    expect(await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).toEqual({ kind: 'missing' });
    const cached = await repo.get<{ expiresAt: number }>('resolutions', cacheKey());
    expect(cached!.expiresAt - before).toBeGreaterThanOrEqual(DAY);
    expect(cached!.expiresAt - before).toBeLessThan(DAY + 1000);
  });
  it.each([
    { expiresAt: Date.now() - 1, result: { kind: 'missing' } },
    { expiresAt: Infinity, result: { kind: 'missing' } },
    { expiresAt: Date.now() + DAY, result: { kind: 'matched', title: 'Wrong', mediaType: 'movie', year: 0, checkedAt: Date.now() } },
    { expiresAt: Date.now() + DAY, result: { kind: 'matched', title: 'Wrong', mediaType: 'movie', year: 2012, checkedAt: Infinity } },
    { expiresAt: Date.now() + DAY, result: null },
  ])('ignores expired or malformed source cache %#', async cached => {
    const repo = repository(); await repo.put('resolutions', cacheKey(), cached);
    const fetcher = vi.fn<typeof fetch>(async () => response());
    expect((await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).kind).toBe('matched');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not fetch unsupported IDs, disabled/cache-only/offline settings or absent demand', async () => {
    const repo = repository(), fetcher = vi.fn<typeof fetch>(async () => response());
    const resolver = new NetflixMetadataResolver(repo, eligibility, fetcher);
    expect(await resolver.resolve({ platformId: 'future', titleId: '123' }, () => true)).toEqual({ kind: 'missing' });
    expect((await resolver.resolve(ref('../watch/123'), () => true)).kind).toBe('deferred');
    await resolver.resolve(ref(), () => false);
    await new NetflixMetadataResolver(repo, async () => ({ enabled: false, cacheOnly: false }), fetcher).resolve(ref(), () => true);
    await new NetflixMetadataResolver(repo, async () => ({ enabled: true, cacheOnly: true }), fetcher).resolve(ref(), () => true);
    vi.stubGlobal('navigator', { onLine: false });
    expect(await resolver.resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', reason: 'offline' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rechecks eligibility before dispatch and releases the durable lease', async () => {
    const repo = repository(); let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async () => response());
    expect(await new NetflixMetadataResolver(repo, async () => ({ enabled: true, cacheOnly: ++calls >= 3 }), fetcher).resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', reason: 'busy' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repo.get('state', 'netflix-metadata:transport')).toMatchObject({ leaseUntil: 0, failures: 0 });
  });
  it('retains a surviving singleflight consumer when the first loses demand', async () => {
    const repo = repository(); let active = true, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => { await gate; return response(); });
    const resolver = new NetflixMetadataResolver(repo, eligibility, fetcher);
    const first = resolver.resolve(ref(), () => active);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = resolver.resolve(ref(), () => true); active = false; release();
    expect((await first).kind).toBe('matched'); expect((await second).kind).toBe('matched'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('serializes distinct lookups and leaves at least 500 ms between starts', async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async input => { starts.push(Date.now()); return response(page(new URL(String(input)).pathname.split('/').at(-1))); });
    const resolver = new NetflixMetadataResolver(repository(), eligibility, fetcher);
    expect((await Promise.all([resolver.resolve(ref(), () => true), resolver.resolve(ref('123'), () => true)])).every(value => value.kind === 'matched')).toBe(true);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(500);
  });
  it('bounds queued demand at one hundred and drops cancelled queued consumers', async () => {
    let release!: (value: Response) => void, active = true;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
    const resolver = new NetflixMetadataResolver(repository(), eligibility, fetcher);
    const first = resolver.resolve(ref(), () => active);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const queued = Array.from({ length: 100 }, (_, i) => resolver.resolve(ref(String(1000 + i)), () => active));
    expect(await Promise.race(queued)).toMatchObject({ kind: 'deferred', reason: 'busy', message: expect.stringContaining('busy') });
    active = false; release(response());
    expect((await first).kind).toBe('matched');
    expect((await Promise.all(queued)).every(value => value.kind === 'deferred')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('bounded public redirects and durable transient failure handling', () => {
  it('follows at most two inspectable same-origin same-title locale redirects', async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => {
      starts.push(Date.now());
      return starts.length <= 2 ? new Response('', { status: 302, headers: { Location: starts.length === 1 ? '/gb/title/70259085' : '/title/70259085' } }) : response();
    });
    expect((await new NetflixMetadataResolver(repository(), eligibility, fetcher).resolve(ref(), () => true)).kind).toBe('matched');
    expect(starts).toHaveLength(3); expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(500); expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(500);
  });
  it.each(['https://evil.test/title/70259085', '/title/999', '/login', 'http://www.netflix.com/title/70259085'])('never follows an untrusted redirect %s', async location => {
    const repo = repository(), fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 302, headers: { Location: location } }));
    expect(await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await repo.all('resolutions')).toHaveLength(0);
  });
  it.each([
    () => response('Sign in'),
    () => response(page('999')),
    () => response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => new Response(page(), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('', { status: 503 }),
    () => new Response('', { status: 206 }),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-test-details')); } }), { headers: { 'Content-Type': 'text/html' } }),
    () => Object.defineProperty(new Response(), 'type', { value: 'opaqueredirect' }),
  ])('keeps interrupted, oversized, opaque or invalid source results out of negative cache %#', async factory => {
    const repo = repository(), fetcher = vi.fn<typeof fetch>(async () => factory());
    const result = await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true);
    expect(result).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(JSON.stringify(result)).not.toContain('private-test-details');
    expect(await repo.all('resolutions')).toHaveLength(0);
    expect(await repo.get('state', 'netflix-metadata:transport')).toMatchObject({ failures: 1, leaseUntil: 0 });
  });
  it('persists Retry-After across workers without counting OMDb usage', async () => {
    const repo = repository(), before = Date.now();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 429, headers: { 'Retry-After': '3600' } }));
    expect(await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', retryAfter: expect.any(Number) });
    expect(await repo.get('state', 'netflix-metadata:transport')).toMatchObject({ cooldownUntil: expect.any(Number) });
    const next = await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref('123'), () => true);
    expect(next).toMatchObject({ kind: 'deferred', reason: 'provider' });
    if (next.kind === 'deferred') expect(next.retryAfter).toBeGreaterThanOrEqual(before + 3600000);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await repo.all('attempts')).toHaveLength(0);
  });
  it('blocks concurrent worker instances with the same persisted lease', async () => {
    const repo = repository(); let release!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; }));
    const first = new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref('123'), () => true)).toMatchObject({ kind: 'deferred', reason: 'busy' });
    release(response()); expect((await first).kind).toBe('matched'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('fails closed if durable dispatch reservation fails', async () => {
    const repo = repository(); vi.spyOn(repo, 'transaction').mockRejectedValue(new Error('disk full'));
    const fetcher = vi.fn<typeof fetch>(async () => response());
    expect(await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses a twelve-second request timeout and does not cache rejected requests', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const repo = repository(), fetcher = vi.fn<typeof fetch>(async () => { throw new DOMException('private-test-details', 'TimeoutError'); });
    expect(await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(timeout).toHaveBeenCalledWith(12000);
    expect(await repo.all('resolutions')).toHaveLength(0);
  });
  it('recovers an expired worker lease and refuses a backwards clock', async () => {
    const repo = repository(), fetcher = vi.fn<typeof fetch>(async () => response());
    await repo.put('state', 'netflix-metadata:transport', { leaseUntil: Date.now() - 1, nextAt: 0, failures: 0, cooldownUntil: 0, lastClock: Date.now() });
    expect((await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref(), () => true)).kind).toBe('matched');
    await repo.put('state', 'netflix-metadata:transport', { leaseUntil: 0, nextAt: 0, failures: 0, cooldownUntil: 0, lastClock: Date.now() + 120000 });
    expect(await new NetflixMetadataResolver(repo, eligibility, fetcher).resolve(ref('123'), () => true)).toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
