import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

let browser: Browser;
let script: string;
test.beforeAll(async () => {
  script = (await build({ entryPoints: ['src/platforms/netflix/index.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'NetflixAdapterFixture', target: 'chrome120' })).outputFiles[0].text;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => { await browser?.close(); });
async function fixture(path: string, html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith('https://www.netflix.com/')
    ? route.fulfill({ contentType: 'text/html', body: `<style>body{margin:0}.card,.title-card-container{width:280px;height:165px}.card>a,.title-card-container>a{display:block;width:280px;height:165px}img{display:block;width:280px;height:165px}</style>${html}` })
    : route.abort());
  await page.goto(`https://www.netflix.com${path}`); await page.addScriptTag({ content: script });
  return page;
}
const image = '<img alt="Fixture Film" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'280\' height=\'165\'%3E%3C/svg%3E">';

test('modern search and latest cards retain whole-work identity and safe artwork/mount boundaries', async () => {
  for (const path of ['/search?q=hindi', '/latest', '/browse/originals', '/browse/original-audio', '/browse/audio-description', '/browse/person/123']) {
    const page = await fixture(path, `<div class="card" id="wrapper"><a data-uia="standard-card" aria-label="Fixture Film" href="${path}${path.includes('?') ? '&' : '?'}jbv=1001">${image}<span class="progress">50%</span></a></div>`);
    const result = await page.evaluate(() => {
      const adapter = (window as unknown as { NetflixAdapterFixture: { netflixAdapter: import('../../src/platforms/contracts').StreamingPlatformAdapter } }).NetflixAdapterFixture.netflixAdapter;
      const tile = [...adapter.findTiles(document)][0];
      return { supported: adapter.supports(new URL(location.href)), observation: adapter.observeTitle(tile),
        container: adapter.badgeContainer(tile)?.id, artworkTag: adapter.artworkElement?.(tile)?.tagName };
    });
    expect(result).toMatchObject({ supported: true, observation: { ref: { platformId: 'netflix', titleId: '1001' }, displayTitle: 'Fixture Film' }, container: 'wrapper', artworkTag: 'IMG' });
    await page.close();
  }
});

test('classic search cards use explicit title labels and never watch episode IDs', async () => {
  const page = await fixture('/search?q=film', `<div class="title-card"><div class="title-card-container" id="classic"><a class="slider-refocus" href="/title/1002"><div class="boxart-container">${image}<div class="fallback-text">Fixture Film</div></div></a></div></div><div class="title-card"><div class="title-card-container"><a class="slider-refocus" href="/watch/9999">${image}</a></div></div>`);
  const result = await page.evaluate(() => {
    const adapter = (window as unknown as { NetflixAdapterFixture: { netflixAdapter: import('../../src/platforms/contracts').StreamingPlatformAdapter } }).NetflixAdapterFixture.netflixAdapter;
    return [...adapter.findTiles(document)].map(tile => ({ title: adapter.observeTitle(tile), container: adapter.badgeContainer(tile)?.id }));
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ title: { ref: { titleId: '1002' }, displayTitle: 'Fixture Film' }, container: 'classic' });
  await page.close();
});

test('latest playback-link cards require agreeing scoped public recommendation entities', async () => {
  const contexts: Array<{ context: unknown; href: string; outside?: boolean; modal?: boolean }> = [
    { context: { video_id: 81737430, unifiedEntityId: 'Video:81737430', ignored_request_field: 'DO_NOT_COPY' }, href: '/watch/81737430?tctx=opaque' },
    { context: { video_id: '83124264', unifiedEntityId: 'Video:83124264' }, href: '/watch/83124264' },
    { context: { video_id: 1001, unifiedEntityId: 'Video:1001' }, href: '/watch/9999' },
    { context: { video_id: 1001, unifiedEntityId: 'Episode:1001' }, href: '/watch/1001' },
    { context: { video_id: 1001 }, href: '/watch/1001' },
    { context: { video_id: 'bad', unifiedEntityId: 'Video:bad' }, href: '/watch/1001' },
    { context: { video_id: 1001, unifiedEntityId: 'Video:1001' }, href: 'https://www.netflix.com.evil.test/watch/1001' },
    { context: { video_id: 1001, unifiedEntityId: 'Video:1001' }, href: '/watch/1001', outside: true },
    { context: { video_id: 1001, unifiedEntityId: 'Video:1001', oversized: 'x'.repeat(17000) }, href: '/watch/1001' },
    { context: { video_id: 1001, unifiedEntityId: 'Video:1001' }, href: '/watch/1001', modal: true },
  ];
  const page = await fixture('/latest', contexts.map(({ context, href, outside, modal }, index) =>
    `${modal ? '<section data-uia="modal-motion-container-DETAIL_MODAL">' : ''}<div class="${outside ? 'unrelated-container' : 'title-card'}"><div class="ptrack-content" data-ui-tracking-context="${encodeURIComponent(JSON.stringify(context))}"><a class="slider-refocus" aria-label="Fixture ${index}" href="${href}">${image}</a></div></div>${modal ? '</section>' : ''}`).join('') +
    `<div class="title-card"><div class="ptrack-content" data-ui-tracking-context="%broken"><a class="slider-refocus" aria-label="Malformed" href="/watch/1001">${image}</a></div></div>`);
  const result = await page.evaluate(() => {
    const adapter = (window as unknown as { NetflixAdapterFixture: { netflixAdapter: import('../../src/platforms/contracts').StreamingPlatformAdapter } }).NetflixAdapterFixture.netflixAdapter;
    return [...adapter.findTiles(document)].flatMap(tile => adapter.observeTitle(tile) ?? []);
  });
  expect(result.map(value => value.ref.titleId)).toEqual(['81737430', '83124264']);
  expect(JSON.stringify(result)).not.toMatch(/DO_NOT_COPY|ignored_request_field|tctx|unifiedEntityId/);
  await page.close();
});

test('ambiguous classic links, missing labels and shared geometry cannot borrow another title identity', async () => {
  const page = await fixture('/search', `<div class="title-card"><div class="title-card-container"><a class="slider-refocus" href="/title/1001">${image}</a><a class="slider-refocus" href="/title/1002">${image}</a></div></div><div class="card"><a data-uia="standard-card" href="/browse?jbv=1003"><span>Unverified free text</span></a></div>`);
  const result = await page.evaluate(() => {
    const adapter = (window as unknown as { NetflixAdapterFixture: { netflixAdapter: import('../../src/platforms/contracts').StreamingPlatformAdapter } }).NetflixAdapterFixture.netflixAdapter;
    return [...adapter.findTiles(document)].flatMap(tile => adapter.observeTitle(tile) ?? []);
  });
  expect(result).toEqual([]);
  await page.close();
});

test('detail modal uses its own hero, keeps its controls outside effects, and ignores episode/recommendation links', async () => {
  const page = await fixture('/browse?jbv=1001', `<div class="card" id="behind"><a data-uia="standard-card" aria-label="Behind Film" href="/browse?jbv=1002">${image}</a></div><div data-uia="modal-motion-container-DETAIL_MODAL" role="dialog" id="detail" style="width:700px"><div data-uia="previewModal--player_container">${image}</div><a href="/watch/99999">Play episode</a><button id="play">Play</button><div class="title-card"><div class="title-card-container"><a class="slider-refocus" href="/title/1003"><img alt="Recommendation"></a></div></div></div>`);
  const result = await page.evaluate(() => {
    const adapter = (window as unknown as { NetflixAdapterFixture: { netflixAdapter: import('../../src/platforms/contracts').StreamingPlatformAdapter } }).NetflixAdapterFixture.netflixAdapter;
    const modal = document.querySelector<HTMLElement>('#detail')!, behind = document.querySelector<HTMLElement>('#behind>a')!;
    const artwork = adapter.artworkElement?.(modal);
    return { title: adapter.observeTitle(modal), container: adapter.badgeContainer(modal)?.id,
      artworkTag: artwork?.tagName, affectsPlay: artwork?.contains(document.querySelector('#play')), modalObscured: adapter.isObscured(modal), behindObscured: adapter.isObscured(behind) };
  });
  expect(result).toMatchObject({ title: { ref: { titleId: '1001' }, displayTitle: 'Fixture Film' }, container: 'detail', artworkTag: 'IMG', affectsPlay: false, modalObscured: false, behindObscured: true });
  await page.close();
});

test('recycled modern cards re-read title IDs and labels, with a marker-only fallback for ambiguous artwork', async () => {
  const page = await fixture('/latest', `<div class="card"><a data-uia="standard-card" aria-label="First" href="/latest?jbv=1001">${image}</a></div>`);
  const result = await page.evaluate(() => {
    const adapter = (window as unknown as { NetflixAdapterFixture: { netflixAdapter: import('../../src/platforms/contracts').StreamingPlatformAdapter } }).NetflixAdapterFixture.netflixAdapter;
    const tile = [...adapter.findTiles(document)][0];
    const before = adapter.observeTitle(tile);
    tile.setAttribute('aria-label', 'Second'); tile.setAttribute('href', '/latest?jbv=1002');
    tile.append(document.createElement('img'));
    return { before, after: adapter.observeTitle(tile), artwork: adapter.artworkElement?.(tile) === null };
  });
  expect(result).toMatchObject({ before: { ref: { titleId: '1001' }, displayTitle: 'First' }, after: { ref: { titleId: '1002' }, displayTitle: 'Second' }, artwork: true });
  await page.close();
});
