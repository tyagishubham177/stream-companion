import { chromium, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

const hotstar = 'https://www.hotstar.com';
const netflix = 'https://www.netflix.com';
const moviePath = '/in/movies/fixture-film/9101';
const showPath = '/in/shows/fixture-show/9102';
const episodePath = `${showPath}/episode-two/9912/watch`;
const hoverPath = '/in/movies/fixture-preview/9103';
const poster = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 320 180%22%3E%3Crect width=%22320%22 height=%22180%22 fill=%22teal%22/%3E%3C/svg%3E';
const image = (title: string) => `<span data-testid="hs-image"><img src="${poster}" alt="${title}"></span>`;
const movieTile = `<div id="movie" data-testid="action"><a data-testid="link" href="${moviePath}?tracking=fixture">${image('Fixture Film')}</a></div>`;
const showTile = `<div id="progress" data-testid="action"><a data-testid="link" aria-label="Fixture Show, Show, Season 1, Episode 2, Continue Watching" href="${episodePath}">${image('Episode Two')}</a></div>`;
const hoverTile = `<div id="preview" data-testid="tray-card-hover"><div data-testid="card-hover-container">${image('Fixture Preview artwork')}
  <div data-testid="card-hover-title-cutout"><img src="${poster}" alt="Fixture Preview"></div><span data-testid="textTag">2020</span>
  <a data-testid="link" href="${hoverPath}/watch">Play preview</a></div></div>`;
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
    #preview, #detail { position: relative; width: 360px; height: 300px; background: #264950; }
    #preview img { width: 100%; height: 135px; object-fit: cover; }
    #preview [data-testid="card-hover-title-cutout"] img { width: 120px; height: 48px; }
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

const hotstarIds: Record<string, string> = { '9101': 'tt9100101', '9102': 'tt9100102', '9103': 'tt9100103', '9912': 'tt9100999' };
const netflixIds: Record<string, string> = { '9101': 'tt9100201' };
const ratings: Record<string, { title: string; type: string; score: string }> = {
  tt0133093: { title: 'Connection fixture', type: 'movie', score: '8.0' },
  tt9100101: { title: 'Fixture Film', type: 'movie', score: '8.1' },
  tt9100102: { title: 'Fixture Show', type: 'series', score: '8.2' },
  tt9100103: { title: 'Fixture Preview', type: 'movie', score: '8.3' },
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
      if (!id || !ratings[id]) return route.fulfill({ json: { Response: 'False', Error: 'Movie not found!' } });
      detailCalls.push(id);
      const entry = ratings[id];
      return route.fulfill({ json: { Response: 'True', Title: entry.title, Year: '2020', Type: entry.type,
        imdbID: id, imdbRating: entry.score, imdbVotes: '1,234' } });
    }
    if (url.origin === hotstar) {
      const markup = url.pathname === moviePath ? detail : `${movieTile}${showTile}${hoverTile}${decoys}`;
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
  expect(detailCalls).toEqual([]);
  expect(identityCalls).toEqual([]);

  await options.getByRole('switch', { name: 'IMDb ratings' }).uncheck();
  await home.bringToFront();
  await expect(badge(home)).toHaveCount(0);
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
  await expect(home.locator('#decoys [data-sc-root]')).toHaveCount(0);
  expect(identityCalls.filter(call => call.platform === 'hotstar').flatMap(call => call.ids)).toEqual(expect.arrayContaining(['9101', '9102', '9103']));
  expect(identityCalls.flatMap(call => call.ids)).not.toContain('9912');

  const popup = await context.newPage();
  await popup.goto(`${base}/popup.html`);
  await popup.getByRole('switch', { name: 'Mark as watched' }).uncheck();
  await home.bringToFront();
  await expect(mark(home)).toHaveCount(0);
  await expect(badge(home.locator('#movie'))).toHaveText('★ IMDb 8.1');
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
