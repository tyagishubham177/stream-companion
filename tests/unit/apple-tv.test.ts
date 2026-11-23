import { describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/platforms/registry';
import { platformLabel, platformTitleUrl } from '../../src/platforms/links';
import { parseWikidataResponse } from '../../src/providers/wikidata';
import { PROTOCOL_VERSION } from '../../src/shared/contracts';
import { authoriseRequest, validateRequest, validObservation } from '../../src/shared/validation';

const origin = 'https://tv.apple.com';
const titleId = 'umc.cmc.1srk2goyh2q2zdxcx605w8vtx';
const pagePath = `/in/show/severance/${titleId}`;
const essentials = '/in/collection/essentials/edt.col.690d386c-28b6-4f7f-a0c6-47e9a7eb68ba';
const ref = { platformId: 'apple-tv', titleId };
const observation = { ref, displayTitle: 'Severance', mediaType: 'series' as const, adapterVersion: 1, pagePath };
const sender = (url: string, frameId = 0): chrome.runtime.MessageSender => ({
  id: 'ext', url, frameId, documentId: 'doc', tab: { id: 1, incognito: false } as chrome.tabs.Tab,
});

describe('Apple TV platform wiring', () => {
  it.each(['/', '/in', '/in/', '/gb/search?term=Severance', `${essentials}?ctx_shelf=fixture`,
    '/in/room/tv-shows-on-apple-tv/edt.item.690d376a-3d01-4c9f-825e-79e3f8ba78ea',
    '/in/channel/mls/tvs.sbd.7000', '/in/shelf/all-tv-shows/uts.shlf.gen.tv-plus-shows',
    '/in/person/example/umc.cpc.example', pagePath, `/in/movie/fixture/${titleId}`, `/show/${titleId}`,
    `/in/episode/good-news/${titleId}?showId=${titleId}`,
  ])('supports Apple TV catalogue and title routes at %s', route => {
    expect(adapterFor(new URL(route, origin))?.id).toBe('apple-tv');
  });

  it.each([`${origin}/in/watch/${titleId}`, `${origin}/in/movie/fixture/${titleId}/watch`,
    `${origin}/in/account`, `${origin}/in/clip/fixture/${titleId}`,
    'https://tv.apple.com.lookalike.test/in', 'https://tv.apple.com:8443/in', 'https://x@tv.apple.com/in',
    'http://tv.apple.com/in', `${origin}/in/movie/bad%2fslug/${titleId}`,
  ])('excludes unrelated or insecure routes at %s', route => {
    expect(adapterFor(new URL(route))).toBeUndefined();
  });

  it('requires canonical whole-title paths and preserves links for saved marks', () => {
    expect(platformLabel(ref.platformId)).toBe('Apple TV');
    expect(platformTitleUrl(observation)).toBe(origin + pagePath);
    expect(validObservation({ ...observation, year: { value: 2022, meaning: 'series_start' } })).toBe(true);
    for (const invalid of [{ pagePath: undefined }, { pagePath: `${pagePath}?showId=${titleId}` },
      { pagePath: `/in/episode/fixture/${titleId}` }, { pagePath: `${origin}${pagePath}` },
      { pagePath: `/in/show/fixture/umc.cmc.${'a'.repeat(24)}` }, { mediaType: 'movie' },
      { year: { value: 2025, meaning: 'season_release' } }, { ref: { platformId: 'apple-tv', titleId: '12345' } }]) {
      expect(validObservation({ ...observation, ...invalid })).toBe(false);
    }
    expect(platformTitleUrl({ ...observation, pagePath: `/in/episode/fixture/${titleId}` })).toBeNull();
  });

  it('authorizes top-level Apple catalogue senders and isolates platform references', () => {
    const lookup = validateRequest({ protocol: PROTOCOL_VERSION, type: 'LOOKUP', observation });
    const appleSender = sender(origin + essentials);
    expect(authoriseRequest(appleSender, 'ext', lookup)).toEqual({ role: 'content', platformId: 'apple-tv' });
    expect(() => authoriseRequest(sender(origin + essentials, 1), 'ext', lookup)).toThrow(/sender/i);
    expect(() => authoriseRequest(sender(origin + '/in/account'), 'ext', lookup)).toThrow(/sender/i);
    expect(() => authoriseRequest(sender(`blob:${origin}/fixture`), 'ext', { type: 'GET_PUBLIC_STATUS' })).toThrow(/sender/i);
    expect(() => authoriseRequest(sender('https://www.netflix.com/browse'), 'ext', lookup)).toThrow(/platform title/i);
    expect(() => authoriseRequest(appleSender, 'ext', { type: 'GET_MARKS', refs: [{ platformId: 'netflix', titleId: '12345' }] })).toThrow(/platform title/i);
    expect(() => authoriseRequest(appleSender, 'ext', { type: 'GET_HOTSTAR_POSTERS' })).toThrow(/Hotstar poster evidence/i);
    const withYear = validateRequest({ protocol: PROTOCOL_VERSION, type: 'LOOKUP', observation: {
      ...observation, year: { value: 2022, meaning: 'series_start' },
    } });
    expect(authoriseRequest(sender(origin + pagePath), 'ext', withYear)).toEqual({ role: 'content', platformId: 'apple-tv' });
    expect(() => authoriseRequest(appleSender, 'ext', withYear)).toThrow(/title year/i);
  });

  it('validates local batches and applies the same platform and year authority to every observation', () => {
    const validate = (observations: unknown[]) => validateRequest({ protocol: PROTOCOL_VERSION, type: 'LOOKUP_CACHED', observations });
    const senderPage = sender(origin + essentials);
    expect(authoriseRequest(senderPage, 'ext', validate([observation]))).toMatchObject({ platformId: 'apple-tv' });
    expect(() => validate([])).toThrow(/cached lookup batch/);
    expect(() => validate(Array.from({ length: 101 }, () => observation))).toThrow(/cached lookup batch/);
    const other = { ...observation, pagePath: undefined, ref: { platformId: 'netflix', titleId: '1234' } };
    expect(() => authoriseRequest(senderPage, 'ext', validate([observation, other]))).toThrow(/platform title/i);
    const withYear = { ...observation, year: { value: 2022, meaning: 'series_start' } };
    expect(() => authoriseRequest(senderPage, 'ext', validate([withYear]))).toThrow(/title year/i);
  });

  it('strictly validates Apple IDs and preserves ambiguous Wikidata results', () => {
    const row = (imdbId: string) => ({ appleTvId: { type: 'literal', value: titleId },
      item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q123' }, imdbId: { type: 'literal', value: imdbId } });
    const result = (bindings: ReturnType<typeof row>[]) => ({ head: { vars: ['appleTvId', 'item', 'imdbId'] }, results: { bindings } });
    const now = Date.now();
    expect(parseWikidataResponse(result([row('tt11280740')]), [titleId], now, 'apple-tv').get(titleId))
      .toMatchObject({ kind: 'matched', imdbId: 'tt11280740' });
    expect(parseWikidataResponse(result([row('tt11280740'), row('tt11280741')]), [titleId], now, 'apple-tv').get(titleId))
      .toEqual({ kind: 'ambiguous' });
    expect(() => parseWikidataResponse(result([]), ['12345'], now, 'apple-tv')).toThrow(/invalid/i);
  });
});
