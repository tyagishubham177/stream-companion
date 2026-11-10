import { chromium, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

const hotstar = 'https://www.hotstar.com';
const netflix = 'https://www.netflix.com';
const moviePath = '/in/movies/fixture-film/9101';
const showPath = '/in/shows/fixture-show/9102';
const episodePath = `${showPath}/episode-two/9912/watch`;
const hoverPath = '/in/movies/fixture-preview/9103';
const nativeScorePath = '/in/movies/fixture-native-score/9105';
const pairedShowPath = '/in/shows/fixture-paired-show/9106';
const poster = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 320 180%22%3E%3Crect width=%22320%22 height=%22180%22 fill=%22teal%22/%3E%3C/svg%3E';
const image = (title: string) => `<span data-testid="hs-image"><img src="${poster}" alt="${title}"></span>`;
const movieTile = `<div id="movie" data-testid="action"><a data-testid="link" href="${moviePath}?tracking=fixture">${image('Fixture Film')}</a></div>`;
const showTile = `<div id="progress" data-testid="action"><a data-testid="link" aria-label="Fixture Show, Show, Season 1, Episode 2, Continue Watching" href="${episodePath}">${image('Episode Two')}</a></div>`;
const hoverTile = `<div id="preview" data-testid="tray-card-hover"><div data-testid="card-hover-container">${image('Fixture Preview artwork')}
  <div data-testid="card-hover-title-cutout"><img src="${poster}" alt="Fixture Preview"></div><span data-testid="textTag">2020</span>
  <a data-testid="link" href="${hoverPath}/watch">Play preview</a></div></div>`;
const nativeScoreTile = `<div id="native-score" data-testid="action"><a data-testid="link" href="${nativeScorePath}">${image('Fixture Native Score')}
  <div class="native-score" aria-label="Trending, IMDb 7.8"><span aria-hidden="true"><span data-testid="textTag">IMDb 7.8</span>
    <span data-testid="textTag">IMDb 9.9</span></span></div></a></div>`;
const pairedImage = (asset: string) => `https://img10.hotstar.com/image/upload/f_auto/sources/r1/cms/prod/7001/${asset}.jpg`;
const posterCard = (id: string, asset: string, title: string, category: 'Show' | 'Movie' = 'Show') =>
  `<div id="${id}" data-testid="tray-card-default"><div data-testid="action" aria-label="${title},${category}">
  <span data-testid="hs-image"><img src="${pairedImage(asset)}" alt="${title}"></span></div></div>`;
const pairedTitle = 'Twins';
const verifiedAsset = 'https://img10.hotstar.com/image/upload/f_auto/sources/r1/cms/prod/7001/617539-v';
const verifiedRow = posterCard('verified-poster', '617539-v', 'Modern Family').replace(pairedImage('617539-v'), verifiedAsset) +
  posterCard('different-poster', 'fixture-paired-b', 'Modern Family');
const tvRow = `<div id="tv-row"><div id="tv-posters">${posterCard('paired-poster', 'fixture-paired-a', pairedTitle)}
  ${posterCard('neighbor-poster', 'fixture-paired-b', pairedTitle)}</div>
  <div id="tv-hover-owner" role="button" hidden><div id="tv-preview" data-testid="tray-card-hover"><div data-testid="card-hover-container">
  ${image(`${pairedTitle} artwork`)}<div data-testid="card-hover-title-cutout"><img src="${poster}" alt="${pairedTitle}"></div>
  <span data-testid="textTag">2025</span><span data-testid="textTag">2 Seasons</span><a data-testid="link" href="${pairedShowPath}/watch">Play show</a>
  </div></div></div></div>`;
const uniqueTitle = 'Ash';
const ambiguousTitle = 'Fixture Midnight';
const uniquePosterId = 'tt9100111';
const ambiguousPosterIds = ['tt9100112', 'tt9100113'];
const uniquePosterAsset = 'fixture-harbor-v';
const ambiguousPosterAsset = 'fixture-midnight-v';
const coldShowTitle = 'Arc';
const coldShowId = 'tt9100114';
const coldShowAsset = 'fixture-arc-v';
const unlinkedRow = posterCard('ambiguous-poster', ambiguousPosterAsset, ambiguousTitle, 'Movie') +
  posterCard('unlinked-poster', uniquePosterAsset, uniqueTitle, 'Movie') +
  posterCard('duplicate-poster', uniquePosterAsset, uniqueTitle, 'Movie');
const decoys = `<div id="decoys"><div data-testid="action">${image('Unlinked poster')}</div>
  <div data-testid="action"><a data-testid="link" href="/in/clips/fixture-clip/9104/watch">${image('Fixture Clip')}</a></div></div>`;
const netflixTile = '<div id="netflix-tile" data-uia="title-card"><a data-uia="standard-card" aria-label="Fixture Netflix Film" href="/browse?jbv=9101">Fixture Netflix Film</a></div>';
const detail = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Movie', url: `${hotstar}${moviePath}`, name: 'Fixture Film', releaseYear: '2020' })}</script>
  <section id="detail" data-testid="dt-hero-id"><h1>Fixture Film localized</h1><a data-testid="link" href="${moviePath}/watch">Play</a></section>`;

function document(body: string) {
  return `<!doctype html><meta charset="utf-8"><title>Stream Companion browser fixture</title><style>
    body { margin: 40px; background: #16181a; color: white; font: 16px system-ui; }
    main { display: flex; align-items: flex-start; gap: 24px; }
    [data-testid="action"], #netflix-tile, #netflix-tile a { display: block; width: 260px; height: 160px; background: #264950; }
    [data-testid="action"] a, [data-testid="action"] [data-testid="hs-image"] { display: block; width: 100%; height: 100%; }
    [data-testid="action"] img { display: block; width: 100%; height: 100%; }
    #decoys [data-testid="action"] { width: 130px; height: 80px; }
    #preview, #detail, #tv-preview { position: relative; width: 360px; height: 300px; background: #264950; }
    #preview img, #tv-preview img { width: 100%; height: 135px; object-fit: cover; }
    #preview [data-testid="card-hover-title-cutout"] img, #tv-preview [data-testid="card-hover-title-cutout"] img { width: 120px; height: 48px; }
    #native-score { width: 180px; }
    #native-score a { position: relative; }
    .native-score { position: absolute; bottom: 8px; left: 8px; }
    #tv-row { position: relative; }
    #tv-posters { display: flex; gap: 24px; }
    #tv-hover-owner { position: absolute; top: 0; left: 0; width: 560px; z-index: 2; }
    #tv-preview { width: 100%; }
  </style><h1>Fixture catalogue</h1><main>${body}</main><script>
    window.fixtureLinkClicks = 0;
    document.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('a')) {
        window.fixtureLinkClicks += 1;
        event.preventDefault();
      }
    }, true);
  </script>`;
}

const hotstarIds: Record<string, string> = { '9101': 'tt9100101', '9102': 'tt9100102', '9103': 'tt9100103', '9105': 'tt9100105', '9106': 'tt9100106', '9912': 'tt9100999', '8549': 'tt9100107' };
const netflixIds: Record<string, string> = { '9101': 'tt9100201' };
const ratings: Record<string, { title: string; type: string; score: string; year?: string }> = {
  tt0133093: { title: 'Connection fixture', type: 'movie', score: '8.0' },
  tt9100101: { title: 'Fixture Film', type: 'movie', score: '8.1' },
  tt9100102: { title: 'Fixture Show', type: 'series', score: '8.2' },
  tt9100103: { title: 'Fixture Preview', type: 'movie', score: '8.3' },
  tt9100105: { title: 'Fixture Native Score', type: 'movie', score: '7.1' },
  tt9100106: { title: pairedTitle, type: 'series', score: '8.4' },
  tt9100107: { title: 'Modern Family', type: 'series', score: '8.5' },
  [uniquePosterId]: { title: uniqueTitle, type: 'movie', score: '8.4' },
  [ambiguousPosterIds[0]]: { title: ambiguousTitle, type: 'movie', score: '7.2' },
  [ambiguousPosterIds[1]]: { title: ambiguousTitle, type: 'movie', score: '5.6', year: '2021' },
  [coldShowId]: { title: coldShowTitle, type: 'series', score: '8.2', year: '2021' },
  tt9100201: { title: 'Fixture Netflix Film', type: 'movie', score: '7.4' },
};
let context: BrowserContext;
let profile: string;
let profileRoot: string;
let base: string;
let options: Page;
let home: Page;
const identityCalls: { platform: 'hotstar' | 'netflix'; ids: string[] }[] = [];
const detailCalls: string[] = [];
const omdbSearches: string[] = [];

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({}, info) => {
  // Leave room for Chrome's IndexedDB paths on Windows.
  profileRoot = path.resolve(info.project.outputDir);
  await mkdir(profileRoot, { recursive: true });
  profile = await mkdtemp(path.join(profileRoot, 'profile-'));
  const extension = path.resolve('dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost', '--disable-background-networking'],
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'query.wikidata.org') {
      const query = url.searchParams.get('query') ?? '';
      const isHotstar = query.includes('P11049');
      const platform = isHotstar ? 'hotstar' : 'netflix';
      const column = isHotstar ? 'hotstarId' : 'netflixId';
      const known = isHotstar ? hotstarIds : netflixIds;
      const ids = [...query.matchAll(/"(\d{1,12})"/g)].map(match => match[1]);
      identityCalls.push({ platform, ids });
      return route.fulfill({ json: { head: { vars: [column, 'imdbId', 'item'] }, results: { bindings: ids.filter(id => known[id]).map(id => ({
        [column]: { type: 'literal', value: id }, imdbId: { type: 'literal', value: known[id] },
        item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${id}` },
      })) } } });
    }
    if (url.hostname === 'www.omdbapi.com') {
      const id = url.searchParams.get('i');
      const search = url.searchParams.get('s');
      if (search) {
        omdbSearches.push(search);
        if (search === coldShowTitle && url.searchParams.get('type') === 'series') {
          const page = Number(url.searchParams.get('page'));
          const results = page === 3 ? [{ imdbID: coldShowId, Title: coldShowTitle, Year: '2021', Type: 'series' }] :
            Array.from({ length: 10 }, (_, index) => ({ imdbID: `tt${9100300 + page * 10 + index}`,
              Title: `${coldShowTitle} Companion ${page}-${index}`, Year: '2021', Type: 'series' }));
          return route.fulfill({ json: { Response: 'True', totalResults: '21', Search: results } });
        }
        const candidates = search === uniqueTitle ? [uniquePosterId] : search === ambiguousTitle ? ambiguousPosterIds : [];
        if (candidates.length && url.searchParams.get('type') === 'movie' && url.searchParams.get('page') === '1') {
          return route.fulfill({ json: { Response: 'True', totalResults: String(candidates.length),
            Search: candidates.map(imdbID => ({
              Title: ratings[imdbID].title, Year: ratings[imdbID].year ?? '2020', Type: 'movie', imdbID,
            })) } });
        }
      }
      if (!id || !ratings[id]) return route.fulfill({ json: { Response: 'False', Error: 'Movie not found!' } });
      detailCalls.push(id);
      const entry = ratings[id];
      return route.fulfill({ json: { Response: 'True', Title: entry.title, Year: entry.year ?? '2020', Type: entry.type,
        imdbID: id, imdbRating: entry.score, imdbVotes: '1,234' } });
    }
    if (url.href === verifiedAsset || ['fixture-paired-a', 'fixture-paired-b', uniquePosterAsset, ambiguousPosterAsset, coldShowAsset]
      .some(asset => url.href === pairedImage(asset))) {
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="160"><rect width="260" height="160" fill="teal"/></svg>' });
    }
    if (url.origin === hotstar) {
      const markup = url.pathname === moviePath ? detail : url.searchParams.has('cold-tv') ? posterCard('cold-tv-poster', coldShowAsset, coldShowTitle) :
        url.searchParams.has('unlinked-posters') ? unlinkedRow :
        url.pathname === '/in/shows' || url.searchParams.has('poster-memory') ? tvRow :
        url.pathname === '/in/tv' ? verifiedRow : `${movieTile}${showTile}${hoverTile}${nativeScoreTile}${decoys}`;
      return route.fulfill({ contentType: 'text/html', body: document(markup) });
    }
    if (url.origin === netflix) return route.fulfill({ contentType: 'text/html', body: document(netflixTile) });
    if (url.protocol === 'http:' || url.protocol === 'https:') return route.abort();
    return route.continue();
  });
  const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.js')) ??
    await context.waitForEvent('serviceworker', { predicate: worker => worker.url().endsWith('/background.js'), timeout: 15000 });
  base = `chrome-extension://${new URL(worker.url()).hostname}`;
  await worker.evaluate(() => chrome.runtime.openOptionsPage());
  await expect.poll(() => context.pages().some(page => page.url() === `${base}/options.html`)).toBe(true);
  options = context.pages().find(page => page.url() === `${base}/options.html`)!;
  await expect(options.getByRole('button', { name: 'Save & test' })).toBeEnabled();
});

test.afterAll(async () => {
  await context?.close();
  if (profile && path.dirname(profile) === profileRoot && path.basename(profile).startsWith('profile-')) {
    await rm(profile, { recursive: true, force: true });
  }
});

const badge = (surface: Page | Locator) => surface.locator('[data-sc-root] .badge');
const mark = (surface: Page | Locator) => surface.locator('[data-sc-root="marks"] button');

async function want(page: Page, tile: Locator) {
  const button = mark(tile);
  await expect(button).toBeEnabled();
  await button.press('Enter');
  await page.getByRole('menuitemradio', { name: 'Want to watch', exact: true }).click();
  await expect(button).toHaveAttribute('aria-label', /Want to watch/);
}

test('Hotstar marks work without a key, then ratings and marks toggle independently', async () => {
  home = await context.newPage();
  await home.goto(`${hotstar}/in/home`);
  await expect(mark(home.locator('#movie'))).toBeEnabled();
  const native = home.locator('#native-score');
  await expect(badge(native)).toHaveText('★ IMDb 7.8');
  await badge(native).click();
  const nativeDetails = home.getByRole('dialog', { name: 'Fixture Native Score' });
  await expect(nativeDetails).toContainText('IMDb rating shown by JioHotstar');
  await expect(nativeDetails.getByRole('button', { name: 'Find a match' })).toHaveCount(0);
  await nativeDetails.getByRole('button', { name: 'Close rating details' }).click();
  expect(detailCalls).toEqual([]);
  expect(identityCalls).toEqual([]);
  expect(omdbSearches).toEqual([]);

  await options.getByRole('switch', { name: 'IMDb ratings' }).uncheck();
  await home.bringToFront();
  await expect(badge(home)).toHaveCount(0);
  await expect(mark(native)).toBeEnabled();
  await want(home, home.locator('#movie'));
  await home.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(mark(home.locator('#movie'))).toHaveAttribute('aria-label', /No marks/);
  await expect(home.getByRole('status').filter({ hasText: 'Previous marks restored.' })).toBeVisible();

  await options.locator('#api-key').fill('hotstar_fixture_key');
  await options.getByRole('button', { name: 'Save & test' }).click();
  await expect(options.locator('#notice')).toContainText('Connection test passed');
  expect(detailCalls).toEqual(['tt0133093']);
  await options.getByRole('switch', { name: 'IMDb ratings' }).check();
  await home.bringToFront();
  await expect(badge(home.locator('#movie'))).toHaveText('★ IMDb 8.1');
  await expect(badge(home.locator('#progress'))).toHaveText('★ IMDb 8.2');
  await expect(badge(home.locator('#preview'))).toHaveText('★ IMDb 8.3');
  await expect(badge(native)).toHaveText('★ IMDb 7.8');
  await expect(home.locator('#decoys [data-sc-root]')).toHaveCount(0);
  expect(identityCalls.filter(call => call.platform === 'hotstar').flatMap(call => call.ids)).toEqual(expect.arrayContaining(['9101', '9102', '9103']));
  expect(identityCalls.flatMap(call => call.ids)).not.toContain('9912');
  expect(identityCalls.flatMap(call => call.ids)).not.toContain('9105');
  expect(detailCalls).not.toContain('tt9100105');
  expect(omdbSearches).not.toContain('Fixture Native Score');

  const popup = await context.newPage();
  await popup.goto(`${base}/popup.html`);
  await popup.getByRole('switch', { name: 'Mark as watched' }).uncheck();
  await home.bringToFront();
  await expect(mark(home)).toHaveCount(0);
  await expect(badge(home.locator('#movie'))).toHaveText('★ IMDb 8.1');
  await expect(badge(native)).toHaveText('★ IMDb 7.8');
  await popup.getByRole('switch', { name: 'Mark as watched' }).check();
  await home.bringToFront();
  await expect(mark(home.locator('#movie'))).toBeEnabled();
  await expect(home).toHaveURL(`${hotstar}/in/home`);
  expect(await home.evaluate(() => Reflect.get(window, 'fixtureLinkClicks'))).toBe(0);
  await popup.close();
});

test('Your titles keeps equal platform IDs separate and links Hotstar works to canonical details', async () => {
  const other = await context.newPage();
  await other.goto(`${netflix}/browse`);
  await expect(badge(other.locator('#netflix-tile'))).toHaveText('★ IMDb 7.4');
  await home.bringToFront();
  await want(home, home.locator('#movie'));
  await want(home, home.locator('#progress'));
  await other.bringToFront();
  await want(other, other.locator('#netflix-tile'));
  const titles = await context.newPage();
  await titles.goto(`${base}/titles.html`);
  const entries = titles.getByRole('list', { name: 'Saved titles' }).getByRole('listitem');
  await expect(entries).toHaveCount(3);
  const film = entries.filter({ has: titles.getByRole('heading', { name: 'Fixture Film', exact: true }) });
  const show = entries.filter({ has: titles.getByRole('heading', { name: 'Fixture Show', exact: true }) });
  const netflixFilm = entries.filter({ has: titles.getByRole('heading', { name: 'Fixture Netflix Film', exact: true }) });
  await expect(film).toContainText('JioHotstar');
  await expect(film.getByRole('link')).toHaveAttribute('href', `${hotstar}${moviePath}`);
  await expect(show.getByRole('link')).toHaveAttribute('href', `${hotstar}${showPath}`);
  await expect(netflixFilm).toContainText('Netflix');
  await expect(netflixFilm.getByRole('link')).toHaveAttribute('href', `${netflix}/title/9101`);

  await film.getByRole('button', { name: 'Clear all marks for Fixture Film' }).click();
  await expect(film).toHaveCount(0);
  await home.bringToFront();
  await expect(mark(home.locator('#movie'))).toHaveAttribute('aria-label', /No marks/);
  await other.bringToFront();
  await expect(mark(other.locator('#netflix-tile'))).toHaveAttribute('aria-label', /Want to watch/);
  await titles.bringToFront();
  await titles.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(entries).toHaveCount(3);
  await home.bringToFront();
  await expect(mark(home.locator('#movie'))).toHaveAttribute('aria-label', /Want to watch/);
  expect(await home.evaluate(() => Reflect.get(window, 'fixtureLinkClicks'))).toBe(0);
  expect(await other.evaluate(() => Reflect.get(window, 'fixtureLinkClicks'))).toBe(0);
  await expect(other).toHaveURL(`${netflix}/browse`);
  await titles.close();
  await other.close();
});

test('Hotstar detail shows the same cached rating and the SPA playback route clears the controls', async () => {
  const page = await context.newPage();
  const priorDetails = detailCalls.length;
  await page.goto(`${hotstar}${moviePath}`);
  await expect(badge(page.locator('#detail'))).toHaveText('★ IMDb 8.1');
  await expect(mark(page.locator('#detail'))).toHaveAttribute('aria-label', /^Fixture Film: Want to watch/);
  expect(detailCalls).toHaveLength(priorDetails);

  await page.evaluate(playback => history.pushState({}, '', playback), `${moviePath}/watch`);
  await expect(page).toHaveURL(`${hotstar}${moviePath}/watch`);
  await expect(badge(page)).toHaveCount(0);
  await expect(mark(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Play', exact: true })).toBeVisible();
  await page.goto(`${hotstar}${episodePath}`);
  await expect(page.locator('#progress')).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  await expect(mark(page)).toHaveCount(0);
  expect(detailCalls).toHaveLength(priorDetails);
  await page.close();
});

test('Hotstar remembers a verified TV poster on Home and after reload, without transferring it to different artwork', async () => {
  const page = await context.newPage();
  await page.goto(`${hotstar}/in/shows`);
  const target = page.locator('#paired-poster'), neighbor = page.locator('#neighbor-poster');
  const hover = page.locator('#tv-preview');
  await expect(target.locator('img')).toBeVisible();
  await expect(neighbor.locator('img')).toBeVisible();
  await expect(mark(target)).toHaveCount(0);
  await expect(mark(neighbor)).toHaveCount(0);
  expect(identityCalls.flatMap(call => call.ids)).not.toContain('9106');

  // The broad hover covers both posters with the same label. Neither may
  // acquire a whole-work ID when the geometry does not pick a unique poster.
  await page.locator('#tv-hover-owner').evaluate(owner => { (owner as HTMLElement).hidden = false; });
  await expect(mark(hover)).toBeEnabled();
  await expect(badge(hover)).toHaveText('★ IMDb 8.4');
  await page.locator('#tv-hover-owner').evaluate(owner => { (owner as HTMLElement).hidden = true; });
  await expect(mark(hover)).toHaveCount(0);
  await expect(mark(target)).toHaveCount(0);
  await expect(mark(neighbor)).toHaveCount(0);

  await page.locator('#tv-hover-owner').evaluate(owner => {
    const frame = owner as HTMLElement;
    frame.style.width = '360px'; frame.hidden = false;
  });
  await expect(mark(hover)).toBeEnabled();
  await mark(hover).press('Enter');
  await expect(page.getByRole('menuitemcheckbox', { name: 'Watched so far' })).toBeVisible();
  await page.getByRole('menuitemradio', { name: 'Want to watch', exact: true }).click();
  await expect(mark(hover)).toHaveAttribute('aria-label', /Want to watch/);
  await page.locator('#tv-hover-owner').evaluate(owner => { (owner as HTMLElement).hidden = true; });
  await expect(mark(target)).toHaveAttribute('aria-label', /^Twins: Want to watch/);
  await expect(badge(target)).toHaveText('★ IMDb 8.4');
  await expect(mark(neighbor)).toHaveCount(0);
  await expect(badge(neighbor)).toHaveCount(0);
  expect(identityCalls.filter(call => call.platform === 'hotstar').flatMap(call => call.ids)).toContain('9106');
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureLinkClicks'))).toBe(0);
  await expect(page).toHaveURL(`${hotstar}/in/shows`);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(mark(target)).toHaveAttribute('aria-label', /No marks/);
  await want(page, target);
  const priorDetails = detailCalls.length;
  await page.reload();
  await expect(hover).toBeHidden();
  await expect(badge(target)).toHaveText('★ IMDb 8.4');
  await page.goto(`${hotstar}/in/home?poster-memory=1`);
  await expect(hover).toBeHidden();
  await expect(badge(target)).toHaveText('★ IMDb 8.4');
  await expect(mark(target)).toHaveAttribute('aria-label', /^Twins: Want to watch/);
  await expect(badge(neighbor)).toHaveCount(0);
  expect(detailCalls).toHaveLength(priorDetails);
  await mark(target).press('Enter');
  await page.getByRole('menuitem', { name: 'Clear plan', exact: true }).click();
  await expect(mark(target)).toHaveAttribute('aria-label', /No marks/);
  await page.close();
});

test('Hotstar bootstraps a verified public poster on first sight, but leaves a same-title art variant unassigned', async () => {
  const page = await context.newPage();
  expect(identityCalls.flatMap(call => call.ids)).not.toContain('8549');
  await page.goto(`${hotstar}/in/tv`);
  await expect(badge(page.locator('#verified-poster'))).toHaveText('★ IMDb 8.5');
  await expect(mark(page.locator('#verified-poster'))).toBeEnabled();
  await expect(badge(page.locator('#different-poster'))).toHaveCount(0);
  await expect(mark(page.locator('#different-poster'))).toHaveCount(0);
  await page.close();
});

test('Hotstar rates unseen Home posters before hover only when their title search is unambiguous', async () => {
  const page = await context.newPage();
  const priorIdentities = identityCalls.length;
  const priorSearches = omdbSearches.length;
  const priorDetails = detailCalls.length;
  await page.goto(`${hotstar}/in/home?unlinked-posters=1`);
  const target = page.locator('#unlinked-poster');
  const duplicate = page.locator('#duplicate-poster');
  const ambiguous = page.locator('#ambiguous-poster');
  await expect(page.locator('main a, [data-testid="tray-card-hover"]')).toHaveCount(0);
  await expect(badge(target)).toHaveText('☆ IMDb 8.4');
  await expect(badge(duplicate)).toHaveText('☆ IMDb 8.4');
  await expect(target.locator('[data-sc-root="badge"]')).toHaveAttribute('data-sc-rating-origin', 'fresh');
  await expect(page.locator('[data-sc-root="ratings"]')).toHaveAttribute('data-sc-poster-lookups', /"ambiguous":1/);
  await expect(badge(ambiguous)).toHaveCount(0);
  await expect(mark(page)).toHaveCount(0);
  expect(omdbSearches.slice(priorSearches).sort()).toEqual([uniqueTitle, ambiguousTitle].sort());
  expect(detailCalls.slice(priorDetails)).toEqual([uniquePosterId]);
  expect(identityCalls).toHaveLength(priorIdentities);

  await badge(target).press('Enter');
  const details = page.getByRole('dialog', { name: uniqueTitle });
  await expect(details).toContainText('Possible IMDb match by title and type');
  await expect(details.getByRole('link', { name: 'Open IMDb' })).toHaveAttribute('href', `https://www.imdb.com/title/${uniquePosterId}/`);
  await expect(details.getByRole('button')).toHaveCount(1);
  await expect(details.getByRole('button', { name: 'Close rating details' })).toBeVisible();

  await page.reload();
  await expect(badge(target)).toHaveText('☆ IMDb 8.4');
  await expect(target.locator('[data-sc-root="badge"]')).toHaveAttribute('data-sc-rating-origin', 'cache');
  await expect(badge(duplicate)).toHaveText('☆ IMDb 8.4');
  await target.locator('[data-testid="action"]').evaluate((action, { title, artwork }) => {
    action.setAttribute('aria-label', `${title},Movie`);
    const img = action.querySelector('img')!;
    img.alt = title;
    img.src = artwork;
  }, { title: ambiguousTitle, artwork: pairedImage(ambiguousPosterAsset) });
  await expect(badge(target)).toHaveCount(0);
  await expect(badge(ambiguous)).toHaveCount(0);
  await expect(badge(duplicate)).toHaveText('☆ IMDb 8.4');
  expect(omdbSearches.slice(priorSearches).sort()).toEqual([uniqueTitle, ambiguousTitle].sort());
  expect(detailCalls.slice(priorDetails)).toEqual([uniquePosterId]);
  expect(identityCalls).toHaveLength(priorIdentities);
  expect(await page.evaluate(() => Reflect.get(window, 'fixtureLinkClicks'))).toBe(0);
  await page.close();
});

test('Hotstar TV rates a cold short title beyond page two without expanding the poster', async () => {
  const page = await context.newPage();
  expect(omdbSearches).not.toContain(coldShowTitle);
  expect(detailCalls).not.toContain(coldShowId);
  await page.goto(`${hotstar}/in/shows?cold-tv=1`);
  await expect(page.locator('main a, [data-testid="tray-card-hover"]')).toHaveCount(0);
  const target = page.locator('#cold-tv-poster');
  await expect(badge(target)).toHaveText('☆ IMDb 8.2');
  await expect(target.locator('[data-sc-root="badge"]')).toHaveAttribute('data-sc-rating-origin', 'fresh');
  expect(omdbSearches.filter(title => title === coldShowTitle)).toHaveLength(3);
  expect(detailCalls.filter(id => id === coldShowId)).toHaveLength(1);
  await page.close();
});
