import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/background/repository';
import { AppleTvMetadataResolver, parseAppleTvMetadata } from '../../src/providers/apple-tv-metadata';

const origin = 'https://tv.apple.com';
const series = {
  ref: { platformId: 'apple-tv', titleId: 'umc.cmc.1srk2goyh2q2zdxcx605w8vtx' },
  mediaType: 'series' as const,
  pagePath: '/in/show/severance/umc.cmc.1srk2goyh2q2zdxcx605w8vtx',
};
const movie = {
  ref: { platformId: 'apple-tv', titleId: 'umc.cmc.o5z5ztufuu3uv8lx7m0jcega' },
  mediaType: 'movie' as const,
  pagePath: '/in/movie/greyhound/umc.cmc.o5z5ztufuu3uv8lx7m0jcega',
};
const now = Date.UTC(2026, 10, 23);
const eligible = async () => ({ enabled: true, cacheOnly: false });
const repo = () => new Repository(`apple-tv-metadata-${crypto.randomUUID()}`);
const people = (...names: string[]) => names.map(name => ({ '@type': 'Person', name }));
const script = (body: unknown) => `<script type="application/ld+json">${JSON.stringify(body)}</script>`;
const seriesData = {
  '@context': 'https://schema.org', '@type': 'TVSeries', name: 'Severance',
  datePublished: '2022-02-18T00:00:00.000Z', actor: people('Adam Scott', 'Britt Lower', 'Zach Cherry'),
};
const page = (body: unknown = seriesData, canonical = origin + series.pagePath) =>
  `<!doctype html><html><head><link rel="canonical" href="${canonical}">${script({ '@type': 'Organization', name: 'Apple' })}${script(body)}</head></html>`;
const response = (html = page()) => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

beforeEach(() => vi.stubGlobal('navigator', { onLine: true }));
afterEach(() => vi.unstubAllGlobals());

describe('Apple TV bound public metadata', () => {
  it('reads a series premiere and credits from the canonical public work', () => {
    expect(parseAppleTvMetadata(page(), series, now)).toEqual({
      kind: 'matched', title: 'Severance', mediaType: 'series', year: 2022, checkedAt: now,
      credits: { directors: [], actors: ['Adam Scott', 'Britt Lower', 'Zach Cherry'] },
    });
  });

  it('reads a film release from its matching structured canonical URL and ignores episode data', () => {
    const film = { '@type': 'Movie', name: 'Greyhound', datePublished: '2020-07-10',
      url: origin + movie.pagePath, director: people('Aaron Schneider'), actor: people('Tom Hanks') };
    const html = script({ '@graph': [{ '@type': 'Episode', name: 'Episode', datePublished: '2026-01-01' }, film] });
    expect(parseAppleTvMetadata(html, movie, now)).toEqual({
      kind: 'matched', title: 'Greyhound', mediaType: 'movie', year: 2020, checkedAt: now,
      credits: { directors: ['Aaron Schneider'], actors: ['Tom Hanks'] },
    });
  });

  it.each([
    page(seriesData, 'https://tv.apple.com.example.test' + series.pagePath),
    page({ ...seriesData, url: origin + movie.pagePath }),
    page({ ...seriesData, '@type': 'Episode' }),
    page({ ...seriesData, datePublished: '2022-02-31T00:00:00.000Z' }),
    page({ ...seriesData, datePublished: '2022 other text' }),
    page([seriesData, { ...seriesData, datePublished: '2025-01-17' }]),
    script(seriesData),
    '<!--' + page() + '-->',
    page().replace('Severance', 'Severance"'),
  ])('fails closed for unbound, invalid or conflicting title data %#', html => {
    expect(() => parseAppleTvMetadata(html, series, now)).toThrow();
  });

  it('treats an otherwise bound work without a premiere or release date as missing', () => {
    expect(parseAppleTvMetadata(page({ ...seriesData, datePublished: undefined }), series, now)).toEqual({ kind: 'missing' });
  });
});

describe('Apple TV metadata requests', () => {
  it('coalesces concurrent calls and reuses a persistent result without making a new request', async () => {
    const storage = repo();
    const fetcher = vi.fn<typeof fetch>(async function (this: unknown) {
      expect(this).toBeUndefined();
      return response();
    });
    const resolver = new AppleTvMetadataResolver(storage, eligible, fetcher);
    const result = await Promise.all([resolver.resolve(series, () => true), resolver.resolve(series, () => true)]);
    expect(result[0]).toMatchObject({ kind: 'matched', title: 'Severance', year: 2022 });
    expect(result[0]).toEqual(result[1]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(origin + series.pagePath), expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    }));
    expect(await new AppleTvMetadataResolver(storage, async () => ({ enabled: false, cacheOnly: true }), fetcher)
      .resolve(series, () => false)).toEqual(result[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await storage.all('attempts')).toHaveLength(0);
  });

  it('rejects unbound observation paths and honours settings, offline state and demand', async () => {
    const storage = repo();
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const resolver = new AppleTvMetadataResolver(storage, eligible, fetcher);
    expect(await resolver.resolve({ ...series, pagePath: movie.pagePath }, () => true)).toMatchObject({ kind: 'deferred' });
    expect(await resolver.resolve({ ...series, pagePath: series.pagePath + '?ref=test' }, () => true)).toMatchObject({ kind: 'deferred' });
    expect(await resolver.resolve({ ...series, pagePath: 'https://evil.test' + series.pagePath }, () => true)).toMatchObject({ kind: 'deferred' });
    expect(await resolver.resolve(series, () => false)).toMatchObject({ kind: 'deferred', reason: 'busy' });
    expect(await new AppleTvMetadataResolver(storage, async () => ({ enabled: true, cacheOnly: true }), fetcher)
      .resolve(series, () => true)).toMatchObject({ kind: 'deferred', reason: 'busy' });
    vi.stubGlobal('navigator', { onLine: false });
    expect(await resolver.resolve(series, () => true)).toMatchObject({ kind: 'deferred', reason: 'offline' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('drops queued requests whose cards have left the viewport', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => { await blocked; return response(); });
    const resolver = new AppleTvMetadataResolver(repo(), eligible, fetcher);
    const first = resolver.resolve(series, () => true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    let checks = 0;
    const second = resolver.resolve(movie, () => ++checks === 1);
    await vi.waitFor(() => expect(checks).toBe(1));
    release();
    await expect(first).resolves.toMatchObject({ kind: 'matched' });
    await expect(second).resolves.toMatchObject({ kind: 'deferred', reason: 'busy' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => Object.defineProperty(response(), 'url', { value: origin + movie.pagePath }),
    () => Object.defineProperty(response(), 'redirected', { value: true }),
    () => new Response('', { status: 302, headers: { Location: 'https://example.test' } }),
    () => new Response(page(), { headers: { 'Content-Type': 'application/json' } }),
    () => response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => response('<html>Sign in</html>'),
  ])('does not retain invalid or redirected responses %#', async create => {
    const storage = repo();
    const fetcher = vi.fn<typeof fetch>(async () => create());
    expect(await new AppleTvMetadataResolver(storage, eligible, fetcher).resolve(series, () => true))
      .toMatchObject({ kind: 'deferred', reason: 'provider' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await storage.all('resolutions')).toHaveLength(0);
  });

  it('honours a provider cooldown across workers without contacting another destination', async () => {
    const storage = repo();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    const before = Date.now();
    const first = await new AppleTvMetadataResolver(storage, eligible, fetcher).resolve(series, () => true);
    expect(first).toMatchObject({ kind: 'deferred', reason: 'provider', retryAfter: expect.any(Number) });
    if (first.kind === 'deferred') expect(first.retryAfter).toBeGreaterThanOrEqual(before + 60000);
    expect(await new AppleTvMetadataResolver(storage, eligible, fetcher).resolve(movie, () => true)).toMatchObject({
      kind: 'deferred', reason: 'provider', retryAfter: first.kind === 'deferred' ? first.retryAfter : -1,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
