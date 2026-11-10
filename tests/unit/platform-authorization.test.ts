import { describe, expect, it } from 'vitest';
import { HOTSTAR_ORIGIN, hotstarBrowseSurface, hotstarObservationPath, hotstarTitlePath } from '../../src/platforms/hotstar/routes';
import { platformLabel, platformTitleUrl } from '../../src/platforms/links';
import { authoriseRequest, validateRequest } from '../../src/shared/validation';
import { PROTOCOL_VERSION } from '../../src/shared/contracts';

const netflixUrl = 'https://www.netflix.com/browse';
const hotstarUrl = HOTSTAR_ORIGIN + '/in/home';
const titleId = '1271391489';
const pagePath = '/in/movies/fixture-title/' + titleId;
const hotstarRef = { platformId: 'hotstar', titleId };
const netflixRef = { platformId: 'netflix', titleId };
const observation = { ref: hotstarRef, displayTitle: 'Fixture Title', mediaType: 'movie' as const, adapterVersion: 1, pagePath };
const credits = { directors: ['Example Director'], actors: ['Example Actor', 'Another Actor'] };

function contentSender(url: string, overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return { id: 'ext', url, frameId: 0, documentId: 'doc', tab: { id: 1, incognito: false } as chrome.tabs.Tab, ...overrides };
}

function request(raw: Record<string, unknown>) {
  return validateRequest({ protocol: PROTOCOL_VERSION, ...raw });
}

describe('Hotstar title links and browse routes', () => {
  it.each(['/in/home', '/in/explore', '/in/tv/', '/in/movies', '/in/browse/genre/drama', pagePath,
    '/in/shows/fixture-show/1234567890'])('recognises the catalogue route %s', path => {
    expect(hotstarBrowseSurface(new URL(path, HOTSTAR_ORIGIN))).toBe(true);
  });

  it.each(['/in/watch/' + titleId, pagePath + '/watch', pagePath + '/episode/1', '/in/movies/fixture-title/not-id',
    '/in/my-account', '/in/profile', '/in/sports/cricket/12345', '/in/movies/bad%2fslug/1234'])('excludes the unsupported route %s', path => {
    expect(hotstarBrowseSurface(new URL(path, HOTSTAR_ORIGIN))).toBe(false);
  });

  it('extracts work identity without query parameters, hash, or trailing slash', () => {
    expect(hotstarTitlePath(new URL(HOTSTAR_ORIGIN + pagePath + '/?ref=card#details'))).toEqual({
      titleId, mediaType: 'movie', pagePath,
    });
    expect(hotstarTitlePath(new URL(HOTSTAR_ORIGIN + '/in/shows/example-series/1000'))).toEqual({
      titleId: '1000', mediaType: 'series', pagePath: '/in/shows/example-series/1000',
    });
    expect(hotstarObservationPath(pagePath + '/')).toBeNull();
    expect(hotstarObservationPath(pagePath + '?ref=card')).toBeNull();
    expect(hotstarObservationPath('/in/movies/../movies/fixture-title/' + titleId)).toBeNull();
  });

  it('builds only links with a verified platform and title ID', () => {
    expect(platformLabel('hotstar')).toBe('JioHotstar');
    expect(platformTitleUrl(observation)).toBe(HOTSTAR_ORIGIN + pagePath);
    expect(platformTitleUrl({ ref: hotstarRef })).toBeNull();
    expect(platformTitleUrl({ ref: hotstarRef, pagePath: '/in/movies/fixture-title/123' })).toBeNull();
    expect(platformTitleUrl({ ref: hotstarRef, pagePath: 'https://elsewhere.test' + pagePath })).toBeNull();
    expect(platformTitleUrl({ ref: netflixRef })).toBe('https://www.netflix.com/title/' + titleId);
  });
});

describe('platform authorisation in the service worker', () => {
  it.each([
    { type: 'LOOKUP', observation },
    { type: 'REFRESH', observation, revision: 0 },
    { type: 'OPEN_CORRECTION', observation, revision: 0 },
    { type: 'SET_MARK', observation, watched: true, revision: 0, epoch: 0 },
    { type: 'GET_MARKS', refs: [hotstarRef] },
    { type: 'UNDO_MARK', ref: hotstarRef, operationId: '00000000-0000-0000-0000-000000000000', revision: 0, epoch: 0 },
    { type: 'RELEASE_DEMAND', ref: hotstarRef },
  ])('binds $type title references to the sender platform', input => {
    const validated = request(input);
    expect(authoriseRequest(contentSender(hotstarUrl), 'ext', validated)).toEqual({ role: 'content', platformId: 'hotstar' });
    expect(() => authoriseRequest(contentSender(netflixUrl), 'ext', validated)).toThrow(/Invalid platform title/);
  });

  it('rejects mixed-platform mark reads and preserves same-platform Netflix reads', () => {
    const mixed = request({ type: 'GET_MARKS', refs: [netflixRef, hotstarRef] });
    expect(() => authoriseRequest(contentSender(hotstarUrl), 'ext', mixed)).toThrow(/Invalid platform title/);
    expect(() => authoriseRequest(contentSender(netflixUrl), 'ext', mixed)).toThrow(/Invalid platform title/);
    const netflixRead = request({ type: 'GET_MARKS', refs: [netflixRef] });
    expect(authoriseRequest(contentSender(netflixUrl), 'ext', netflixRead)).toEqual({ role: 'content', platformId: 'netflix' });
    expect(() => authoriseRequest(contentSender(hotstarUrl), 'ext', netflixRead)).toThrow(/Invalid platform title/);
  });

  it.each([
    { url: 'http://www.hotstar.com/in/home' },
    { url: 'https://hotstar.com/in/home' },
    { url: 'https://www.hotstar.com.example.test/in/home' },
    { url: 'https://user:pass@www.hotstar.com/in/home' },
    { url: 'https://www.hotstar.com:8443/in/home' },
    { id: 'different-extension' },
    { frameId: 1 },
    { documentId: undefined },
    { tab: undefined },
    { tab: { id: 1, incognito: true } as chrome.tabs.Tab },
  ])('rejects content without a trusted top-frame Hotstar sender ($url $id $frameId)', overrides => {
    const validated = request({ type: 'LOOKUP', observation });
    expect(() => authoriseRequest(contentSender(hotstarUrl, overrides), 'ext', validated)).toThrow(/Message sender/);
  });

  it('allows cleanup and status on playback while blocking rating and mark requests', () => {
    const playback = contentSender(HOTSTAR_ORIGIN + '/in/watch/' + titleId);
    expect(authoriseRequest(playback, 'ext', request({ type: 'RELEASE_DEMAND' }))).toEqual({ role: 'content', platformId: 'hotstar' });
    expect(authoriseRequest(playback, 'ext', request({ type: 'GET_PUBLIC_STATUS' })).role).toBe('content');
    expect(() => authoriseRequest(playback, 'ext', request({ type: 'RELEASE_DEMAND', ref: netflixRef }))).toThrow(/Invalid platform title/);
    expect(() => authoriseRequest(playback, 'ext', request({ type: 'LOOKUP', observation }))).toThrow(/Message sender/);
    expect(() => authoriseRequest(playback, 'ext', request({ type: 'SET_MARK', observation, plan: 'want', revision: 0, epoch: 0 }))).toThrow(/Message sender/);
    expect(() => authoriseRequest(contentSender('blob:' + HOTSTAR_ORIGIN + '/fixture'), 'ext', request({ type: 'GET_PUBLIC_STATUS' }))).toThrow(/Message sender/);
  });

  it.each([
    { pagePath: pagePath + '?profile=fixture' },
    { pagePath: HOTSTAR_ORIGIN + pagePath },
    { pagePath: '/in/movies/fixture-title/99999' },
    { pagePath: '/in/shows/fixture-title/' + titleId },
    { ref: netflixRef },
    { credits: { ...credits, profile: 'fixture' } },
    { credits: { ...credits, actors: Array.from({ length: 13 }, (_, index) => 'Actor ' + index) } },
    { credits: { ...credits, actors: ['<script>'] } },
    { pagePath: undefined, credits },
  ])('rejects unbound or malformed observations (%j)', override => {
    expect(() => request({ type: 'LOOKUP', observation: { ...observation, ...override } })).toThrow(/Invalid title observation/);
  });

  it.each(['LOOKUP', 'REFRESH', 'OPEN_CORRECTION', 'SET_MARK'])('accepts credits on %s only from a matching detail page', type => {
    const fields = type === 'SET_MARK' ? { plan: 'want', revision: 0, epoch: 0 } :
      type === 'LOOKUP' ? {} : { revision: 0 };
    const validated = request({ type, observation: { ...observation, credits }, ...fields });
    expect(authoriseRequest(contentSender(HOTSTAR_ORIGIN + pagePath), 'ext', validated).role).toBe('content');
    expect(() => authoriseRequest(contentSender(hotstarUrl), 'ext', validated)).toThrow(/Invalid title credits/);
    expect(() => authoriseRequest(contentSender(HOTSTAR_ORIGIN + '/in/movies/another-title/555'), 'ext', validated)).toThrow(/Invalid title credits/);
    expect(() => authoriseRequest(contentSender(HOTSTAR_ORIGIN + '/in/shows/fixture-title/' + titleId), 'ext', validated)).toThrow(/Invalid title credits/);
  });

  it('preserves trusted extension page permissions without widening content permissions', () => {
    const mark = request({ type: 'SET_MARK', observation, plan: 'want', revision: 0, epoch: 0 });
    expect(authoriseRequest({ id: 'ext', url: 'chrome-extension://ext/titles.html' }, 'ext', mark)).toEqual({ role: 'titles' });
    const settings = request({ type: 'UPDATE_SETTINGS', settings: { ratingsEnabled: true, marksEnabled: true } });
    expect(authoriseRequest({ id: 'ext', url: 'chrome-extension://ext/popup.html' }, 'ext', settings)).toEqual({ role: 'popup' });
    expect(() => authoriseRequest(contentSender(hotstarUrl), 'ext', settings)).toThrow(/cannot perform/);
  });
});
