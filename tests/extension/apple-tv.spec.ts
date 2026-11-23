import { chromium, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { ratingsFixture, serveRatingsFixture } from './ratings-fixture';

const apple = 'https://tv.apple.com';
const essentialsPath = '/in/collection/essentials/edt.col.690d386c-28b6-4f7f-a0c6-47e9a7eb68ba';
const essentialsQuery = '?ctx_cvs=edt.cvs.690d3e31-3a2e-4cef-952c-adb9ddfc5452&ctx_shelf=edt.shelf.690d3e31-11e7-44c5-a411-4274d2f588d6';
const tvRoom = '/in/room/tv-shows-on-apple-tv/edt.item.690d376a-3d01-4c9f-825e-79e3f8ba78ea';
const shelf = '/in/shelf/new-releases/uts.col.tv-plus-newest-releases';
const movieId = 'umc.cmc.3t6dvnnr87zwd4wmvpdx5came';
const seriesId = 'umc.cmc.1srk2goyh2q2zdxcx605w8vtx';
const fallbackId = 'umc.cmc.shin43vzfoz3h4ggx41z8rf';
const episodeId = 'umc.cmc.s80mx1ic96pu6ewupz8pfasf';
const moviePath = `/in/movie/f1-the-movie/${movieId}`;
const seriesPath = `/in/show/severance/${seriesId}`;
const fallbackPath = `/in/movie/mayday/${fallbackId}`;
const episodePath = `/in/episode/good-news-about-hell/${episodeId}`;
const episodeQuery = `?showId=${seriesId}`;
const image = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 320 180%22%3E%3Crect width=%22320%22 height=%22180%22 fill=%22teal%22/%3E%3C/svg%3E';

const ratings: Record<string, { title: string; type: 'movie' | 'series'; year: string; score: string }> = {
  tt0133093: { title: 'Connection fixture', type: 'movie', year: '1999', score: '8.0' },
  tt9100601: { title: 'F1 The Movie', type: 'movie', year: '2025', score: '8.1' },
  tt9100602: { title: 'Severance', type: 'series', year: '2022', score: '8.7' },
  tt9100603: { title: 'Mayday', type: 'movie', year: '2026', score: '7.8' },
};
const directIds = new Map([[movieId, 'tt9100601'], [seriesId, 'tt9100602']]);
const imdbScores = ratingsFixture(Object.entries(ratings).map(([id, entry]) => [id, entry.score]));

function card(id: string, href: string, title: string, variant: 'poster' | 'logo' | 'search' | 'resume' = 'poster') {
  const label = variant === 'search' ? ` aria-label="${title}"` : '';
  const testId = variant === 'resume' ? 'continue-watching-lockup' : variant === 'search' ? 'search-card-lockup' : 'lockup';
  return `<div id="${id}" data-testid="${variant === 'resume' ? 'continue-watching-lockup-container' : 'lockup-container'}">
    <a data-testid="${testId}" href="${href.replaceAll('&', '&amp;')}"${label}>
      <div data-testid="artwork"><img src="${image}" alt="" role="presentation"></div>
      ${variant === 'poster' || variant === 'resume' ? `<span class="visually-hidden">${title}</span>` : ''}
      ${variant === 'logo' ? `<img class="logo" src="${image}" alt="${title}">` : ''}
    </a>
  </div>`;
}

const movieCard = card('movie', `${moviePath}?ctx_brand=tvs.sbd.4000`, 'F1 The Movie');
const seriesCard = card('series', seriesPath, 'Severance', 'logo');
const fallbackCard = card('fallback', fallbackPath, 'Mayday');
const resumeCard = card('resume', episodePath + episodeQuery, 'Severance, Good News About Hell, S1, E1, 57 min left', 'resume');
const resumeMovieCard = card('resume-movie', fallbackPath, 'Mayday, 8 min left', 'resume');
const home = `<section id="hero" data-testid="epic-stage-item" aria-label="F1 The Movie">
    <button data-testid="superhero-media-scrim" type="button">F1 The Movie</button>
    <div data-testid="superhero-metadata"><span data-testid="metadata-list">Movie · Action · Drama</span></div>
  </section>${movieCard}${seriesCard}${resumeCard}${resumeMovieCard}
  <section id="promo" data-testid="epic-stage-item" aria-label="Watch Apple Originals">Watch Apple Originals</section>`;
const search = `${card('search-series', seriesPath, 'Severance', 'search')}
  ${card('person', '/in/person/adam-scott/umc.cpc.f578zaejt4e9lg7k74775hj8', 'Adam Scott', 'search')}`;
const player = `<dialog data-testid="playback-view" class="is-initial-load" open></dialog>
  <script>
    const view = document.querySelector('[data-testid="playback-view"]');
    document.getElementById('play-preview').addEventListener('click', () => {
      view.classList.remove('is-initial-load');
      view.innerHTML = '<div data-testid="video-player"><button id="close-player">Close preview</button></div>';
      view.querySelector('button').addEventListener('click', () => {
        view.replaceChildren();
        view.classList.add('is-initial-load');
      });
    });
  </script>`;

function document(body: string, canonical?: string, metadata?: Record<string, unknown>) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Apple TV browser fixture</title>
    ${canonical ? `<link rel="canonical" href="${apple}${canonical}">` : ''}
    ${metadata ? `<script type="application/ld+json">${JSON.stringify(metadata)}</script>` : ''}
    <style>
      body { margin: 32px; background: #141414; color: white; font: 16px system-ui; }
      main { display: flex; flex-wrap: wrap; gap: 20px; }
      :is([data-testid="lockup-container"], [data-testid="continue-watching-lockup-container"]), #promo { width: 180px; height: 135px; }
      :is([data-testid="lockup-container"], [data-testid="continue-watching-lockup-container"]) a, [data-testid="artwork"], [data-testid="artwork"] img { display: block; width: 100%; height: 100%; }
      [data-testid="artwork"] img { object-fit: cover; }
      .logo { position: absolute; left: 16px; bottom: 16px; width: 68px; height: 22px; }
      .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
      #hero, #detail { width: 310px; height: 220px; box-sizing: border-box; padding: 70px 16px 16px; background: #275452; }
      [data-testid="playback-view"].is-initial-load { display: none; }
      [data-testid="playback-view"] { position: fixed; z-index: 10; inset: 35% auto auto; }
    </style></head><body><main>${body}</main></body></html>`;
}

function detail(title: string, type: 'Movie' | 'TVSeries', pagePath: string, year: string, playable = false) {
  return document(`<div id="detail" data-testid="product-header" data-type="${type === 'Movie' ? 'Movie' : 'Show'}">
    <h1 class="visually-hidden">${title}</h1><img class="logo" src="${image}" alt="${title}">
    ${playable ? '<button id="play-preview">Play preview</button>' : ''}
  </div>${playable ? player : ''}`, pagePath, { '@type': type, name: title, datePublished: `${year}-02-18T00:00:00.000Z` });
}

const episodeDetail = document(`<div id="detail" data-testid="product-header" data-type="Episode">
  <span data-testid="superhero-metadata-subtitle"><a href="${seriesPath}">Severance</a></span>
  <h1 data-testid="content-title">Good News About Hell</h1>
</div>`, episodePath + episodeQuery);

const pages = new Map([
  ['/in', document(home)], [essentialsPath, document(`${movieCard}${seriesCard}${fallbackCard}`)],
  [tvRoom, document(seriesCard)], [shelf, document(movieCard)], ['/in/search', document(search)],
  [moviePath, detail('F1 The Movie', 'Movie', moviePath, '2025', true)],
  [seriesPath, detail('Severance', 'TVSeries', seriesPath, '2022')],
  [fallbackPath, detail('Mayday', 'Movie', fallbackPath, '2026')], [episodePath, episodeDetail],
]);

let context: BrowserContext;
let profileRoot: string;
let profile: string;
let extensionOrigin: string;
const identityCalls: string[] = [];
const metadataCalls: string[] = [];
const omdbDetails: string[] = [];
const searches: { title: string; year: string | null; type: string | null }[] = [];

test.beforeAll(async ({}, info) => {
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
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'datasets.imdbws.com') return serveRatingsFixture(route, imdbScores);
    if (url.hostname === 'query.wikidata.org') {
      const query = url.searchParams.get('query') ?? '';
      expect(query).toContain('wdt:P9586');
      expect(query).toContain('wdt:P9751');
      const ids = [...query.matchAll(/"(umc\.cmc\.[a-z0-9]{22,25})"/g)].map(match => match[1]);
      identityCalls.push(...ids);
      const literal = (value: string) => ({ type: 'literal', value });
      return route.fulfill({ json: { head: { vars: ['appleTvId', 'item', 'imdbId', 'workTitle', 'workType', 'workYear'] }, results: {
        bindings: ids.filter(id => directIds.has(id)).map(id => {
          const imdbId = directIds.get(id)!;
          const data = ratings[imdbId];
          return { appleTvId: literal(id), imdbId: literal(imdbId), item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${imdbId.slice(2)}` },
            workTitle: literal(data.title), workType: literal(data.type), workYear: literal(data.year) };
        }),
      } } });
    }
    if (url.hostname === 'www.omdbapi.com') {
      const id = url.searchParams.get('i'), title = url.searchParams.get('s');
      if (id) omdbDetails.push(id);
      if (title) {
        const year = url.searchParams.get('y'), type = url.searchParams.get('type');
        searches.push({ title, year, type });
        if (title === 'Mayday' && year === '2026' && type === 'movie') return route.fulfill({ json: {
          Response: 'True', totalResults: '1', Search: [{ Title: title, Year: year, Type: type, imdbID: 'tt9100603' }],
        } });
      }
      const entry = id && ratings[id];
      return route.fulfill({ json: entry ? { Response: 'True', Title: entry.title, Year: entry.year, Type: entry.type,
        imdbID: id, imdbRating: entry.score, imdbVotes: '1,234' } : { Response: 'False', Error: 'Movie not found!' } });
    }
    if (url.origin === apple) {
      if (request.serviceWorker()) {
        metadataCalls.push(url.pathname);
        const headers = await request.allHeaders();
        expect(headers.cookie).toBeUndefined();
        expect(headers.referer).toBeUndefined();
      }
      return route.fulfill({ status: pages.has(url.pathname) ? 200 : 404,
        contentType: 'text/html; charset=utf-8', body: pages.get(url.pathname) ?? 'Not found' });
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') return route.abort();
    return route.continue();
  });
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js')) ??
    await context.waitForEvent('serviceworker', { predicate: item => item.url().endsWith('/background.js'), timeout: 15000 });
  extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
  await worker.evaluate(() => chrome.runtime.openOptionsPage());
  const optionsUrl = `${extensionOrigin}/options.html`;
  await expect.poll(() => context.pages().some(page => page.url() === optionsUrl)).toBe(true);
  const options = context.pages().find(page => page.url() === optionsUrl)!;
  await expect(options.getByRole('button', { name: 'Save & test' })).toBeEnabled();
  await options.locator('#api-key').fill('apple_fixture_key');
  await options.getByRole('button', { name: 'Save & test' }).click();
  await expect(options.locator('#notice')).toContainText('Connection test passed');
});

test.afterAll(async () => {
  await context?.close();
  if (profile && path.dirname(profile) === profileRoot && path.basename(profile).startsWith('profile-')) {
    await rm(profile, { recursive: true, force: true });
  }
});

const badge = (surface: Locator) => surface.locator('[data-sc-root="badge"] .badge');
const mark = (surface: Locator) => surface.locator('[data-sc-root="marks"] button');

async function saved(page: Page, surface: Locator) {
  const button = mark(surface);
  await expect(button).toBeEnabled();
  await button.press('Enter');
  await page.getByRole('menuitemradio', { name: 'Want to watch', exact: true }).click();
  await expect(button).toHaveAttribute('aria-label', /Want to watch/);
}

test('Apple TV Essentials rates movies and series, including a cold metadata fallback', async () => {
  const page = await context.newPage();
  await page.goto(`${apple}${essentialsPath}${essentialsQuery}`);
  await expect(badge(page.locator('#movie'))).toHaveText('★ IMDb 8.1');
  await expect(badge(page.locator('#series'))).toHaveText('★ IMDb 8.7');
  await expect(badge(page.locator('#fallback'))).toHaveText('★ IMDb 7.8');
  await expect(mark(page.locator('#movie'))).toBeEnabled();
  await expect(mark(page.locator('#series'))).toBeEnabled();
  expect(identityCalls).toEqual(expect.arrayContaining([movieId, seriesId, fallbackId]));
  expect(omdbDetails).not.toContain('tt9100601');
  expect(omdbDetails).not.toContain('tt9100602');
  expect(omdbDetails).toContain('tt9100603');
  expect(metadataCalls).toContain(fallbackPath);
  expect(searches).toContainEqual({ title: 'Mayday', year: '2026', type: 'movie' });
  await page.close();
});

test('Apple TV shares series marks across Home, search, shelves, and episode details', async () => {
  const page = await context.newPage();
  await page.goto(`${apple}/in`);
  await expect(badge(page.locator('#hero'))).toHaveText('★ IMDb 8.1');
  await expect(mark(page.locator('#hero'))).toBeEnabled();
  await expect(page.locator('#promo [data-sc-root]')).toHaveCount(0);
  await expect(badge(page.locator('#resume'))).toHaveText('★ IMDb 8.7');
  await expect(badge(page.locator('#resume-movie'))).toHaveText('★ IMDb 7.8');
  await expect(mark(page.locator('#resume-movie'))).toHaveAttribute('aria-label', /^Mayday: /);
  await expect(page.locator('#resume a [data-sc-root], #resume-movie a [data-sc-root]')).toHaveCount(0);
  await saved(page, page.locator('#resume'));
  await expect(mark(page.locator('#series'))).toHaveAttribute('aria-label', /^Severance: Want to watch/);

  await page.goto(`${apple}/in/search?term=Severance`);
  await expect(badge(page.locator('#search-series'))).toHaveText('★ IMDb 8.7');
  await expect(mark(page.locator('#search-series'))).toHaveAttribute('aria-label', /Want to watch/);
  await expect(page.locator('#person [data-sc-root]')).toHaveCount(0);
  await page.goto(`${apple}${tvRoom}`);
  await expect(badge(page.locator('#series'))).toHaveText('★ IMDb 8.7');
  await page.goto(`${apple}${shelf}`);
  await expect(badge(page.locator('#movie'))).toHaveText('★ IMDb 8.1');

  for (const destination of [episodePath + episodeQuery, `${episodePath}?showId=${fallbackId}`, seriesPath]) {
    await page.goto(`${apple}${destination}`);
    await expect(badge(page.locator('#detail'))).toHaveText('★ IMDb 8.7');
    await expect(mark(page.locator('#detail'))).toHaveAttribute('aria-label', /^Severance: Want to watch/);
  }
  await page.goto(`${extensionOrigin}/titles.html`);
  const entries = page.getByRole('list', { name: 'Saved titles' }).getByRole('listitem');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Apple TV');
  await expect(entries.first().getByRole('link')).toHaveAttribute('href', `${apple}${seriesPath}`);
  expect(identityCalls).not.toContain(episodeId);
  await page.close();
});

test('Apple TV movie controls hide while the in-page player is mounted and return on close', async () => {
  const page = await context.newPage();
  await page.goto(`${apple}${moviePath}`);
  const surface = page.locator('#detail');
  await expect(badge(surface)).toHaveText('★ IMDb 8.1');
  await expect(mark(surface)).toBeEnabled();
  await mark(surface).press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  // Apple may open playback without a pointer event outside the menu.
  await page.locator('#play-preview').evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByTestId('video-player')).toBeVisible();
  await expect(page).toHaveURL(`${apple}${moviePath}`);
  await expect(mark(surface)).toBeHidden();
  await expect(badge(surface)).toBeHidden();
  await expect(page.getByRole('menu')).toBeHidden();
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(badge(surface)).toBeVisible();
  await expect(mark(surface)).toBeVisible();
  await page.close();
});
