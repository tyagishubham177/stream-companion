import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Reply } from '../../src/shared/contracts';

let context: BrowserContext;
let base: string;
let options: Page;
let profile: string;
let requests: URL[] = [];
const identityRequests: URL[] = [];
const networkFailures: Array<{ host: string; method: string; error: string | null }> = [];
let providerMode: 'normal' | 'quota' = 'normal';
const details = (id: string) => ({ Response: 'True', Title: id === 'tt0133093' ? 'Fixture Reference' : id === 'tt7654321' ? 'Fixture Dunes' : 'Fixture Orbit',
  Year: id === 'tt0133093' ? '1999' : '2020', Type: 'movie', imdbID: id,
  imdbRating: id === 'tt7654321' ? 'N/A' : '8.2', imdbVotes: '1,234' });

async function command<T>(page: Page, request: object): Promise<T> {
  const reply = await page.evaluate(async request => await chrome.runtime.sendMessage({ protocol: 1, ...request }), request) as Reply<T>;
  if (!reply.ok) throw new Error(reply.error); return reply.value;
}
async function launch(): Promise<void> {
  const extensionPath = path.resolve('dist');
  await mkdir(profile, { recursive: true });
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP www.omdbapi.com 127.0.0.1, MAP www.netflix.com 127.0.0.1, MAP query.wikidata.org 127.0.0.1, EXCLUDE localhost'] });
  context.on('requestfailed', request => networkFailures.push({ host: new URL(request.url()).hostname, method: request.method(), error: request.failure()?.errorText ?? null }));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'query.wikidata.org') {
      identityRequests.push(url);
      expect(url.searchParams.has('apikey')).toBe(false);
      expect(JSON.stringify(route.request().headers())).not.toContain('fixture_only');
      const ids = [...(url.searchParams.get('query') ?? '').matchAll(/"(\d{1,12})"/g)].map(x => x[1]);
      const known: Record<string, string> = { '1001': 'tt1234567', '1002': 'tt7654321' };
      return route.fulfill({ json: { head: { vars: ['netflixId', 'imdbId', 'item'] }, results: { bindings: ids.filter(id => known[id]).map(id => ({
        netflixId: { type: 'literal', value: id }, imdbId: { type: 'literal', value: known[id] }, item: { type: 'uri', value: `http://www.wikidata.org/entity/Q${id}` }
      })) } } });
    }
    if (url.hostname === 'www.omdbapi.com') {
      requests.push(url);
      if (providerMode === 'quota') return route.fulfill({ json: { Response: 'False', Error: 'Request limit reached!' } });
      const id = url.searchParams.get('i');
      return route.fulfill({ json: id ? details(id) : { Response: 'True', totalResults: '2', Search: [
        { Title: 'Fixture Orbit', Year: '2020', Type: 'movie', imdbID: 'tt1234567' },
        { Title: 'Fixture Orbit', Year: '1990', Type: 'movie', imdbID: 'tt9999999' }
      ] } });
    }
    if (url.hostname === 'www.netflix.com') return route.fulfill({ contentType: 'text/html', body: await readFile('tests/fixtures/browse.html', 'utf8') });
    if (url.protocol === 'http:' || url.protocol === 'https:') return route.abort();
    return route.continue();
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  base = `chrome-extension://${new URL(worker.url()).hostname}`;
  options = await context.newPage(); await options.goto(`${base}/options.html`);
  await expect(options.locator('#save-key')).toBeEnabled();
}
test.beforeAll(async ({}, info) => {
  profile = path.resolve(info.outputPath('profile'));
  await launch();
});
test.afterAll(async () => {
  await context?.close();
  const allowedRoot = path.resolve('test-results') + path.sep;
  if (profile?.startsWith(allowedRoot)) await rm(profile, { recursive: true, force: true });
});
test.describe.configure({ mode: 'serial' });

test('key setup uses the actual MV3 worker, fixed provider and durable ledger', async () => {
  await options.locator('#api-key').fill('fixture_only');
  await options.getByRole('button', { name: 'Save & test' }).click();
  await expect(options.locator('#notice')).toContainText('Connection test passed');
  expect(requests).toHaveLength(1); expect(requests[0].hostname).toBe('www.omdbapi.com');
  await expect(options.locator('#api-key')).toHaveValue('');
  expect(await options.locator('body').innerText()).not.toContain('fixture_only');
  const diagnostics = await command<Record<string, unknown>>(options, { type: 'EXPORT_DIAGNOSTICS' });
  expect(diagnostics.requests24h).toBe(1);
  expect(JSON.stringify(diagnostics)).not.toMatch(/fixture_only|credential|tt1234567|Fixture Orbit/);
  await options.screenshot({ path: 'test-results/settings.png', fullPage: true });
});

test('all visible cards resolve automatically without opening titles; corrections remain optional', async () => {
  const browse = await context.newPage(); await browse.goto('https://www.netflix.com/browse');
  const badges = browse.locator('[data-sc-root]').locator('.badge:visible');
  await expect(browse.locator('a[data-uia="progress-card"]')).toHaveCount(1);
  await expect(badges).toHaveCount(3);
  try { await expect(badges.first()).toHaveText('★ IMDb 8.2'); }
  catch (error) { throw new Error(JSON.stringify({ identityCalls: identityRequests.length, networkFailures }), { cause: error }); }
  await expect(badges.nth(1)).toHaveText('IMDb NR');
  await expect(badges.nth(2)).toHaveText('★ IMDb 8.2');
  expect(requests).toHaveLength(3); // Key test + two unique IMDb IDs, despite a duplicate card.
  expect(identityRequests).toHaveLength(1);
  expect(identityRequests[0].searchParams.get('query')).toContain('1001');
  expect(identityRequests[0].searchParams.get('query')).toContain('1002');
  expect(requests.slice(1).every(url => url.searchParams.has('i') && !url.searchParams.has('s'))).toBe(true);
  await badges.first().click();
  await expect(browse.getByRole('dialog')).toBeVisible();
  await expect(browse.getByRole('dialog')).toContainText('Matched automatically by streaming title ID via Wikidata');
  await browse.keyboard.press('Escape');
  await expect(browse.getByRole('dialog')).toHaveCount(0);
  expect(await browse.evaluate(() => document.querySelector('[data-sc-root]')?.shadowRoot?.activeElement?.className)).toBe('badge');
  await badges.first().press('Enter');
  const newPage = context.waitForEvent('page');
  await browse.getByRole('button', { name: 'Wrong match?', exact: true }).click();
  const correction = await newPage; await correction.waitForLoadState();
  await expect(correction.locator('#source-title')).toHaveText('Fixture Orbit');
  await correction.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(correction.locator('#results li')).toHaveCount(2);
  await correction.getByRole('button', { name: 'Preview Fixture Orbit, 2020', exact: true }).click();
  await expect(correction.locator('#preview-score')).toHaveText('8.2');
  await correction.getByRole('button', { name: 'Confirm this match', exact: true }).click();
  await expect(correction.locator('#notice')).toContainText('Match saved');
  await correction.screenshot({ path: 'test-results/correction.png', fullPage: true });
  await browse.bringToFront();
  await expect(badges.filter({ hasText: '8.2' })).toHaveCount(2);
  expect(await browse.evaluate(() => (window as unknown as { playbackCount: number }).playbackCount)).toBe(0);
  await browse.screenshot({ path: 'test-results/badges.png' });
  // DOM changes must remove the preceding title's score before a delayed response can arrive.
  await browse.evaluate(() => {
    const a = document.querySelector<HTMLAnchorElement>('a[data-uia="standard-card"]')!;
    a.href = '/browse?jbv=1003'; a.setAttribute('aria-label', 'Fixture Unresolved');
  });
  await expect(badges.first()).toHaveText('IMDb —');
  await expect(badges.filter({ hasText: '8.2' })).toHaveCount(1);
  await browse.reload();
  await expect(browse.locator('.badge:visible').filter({ hasText: '8.2' })).toHaveCount(2);
  const count = requests.length;
  await command(options, { type: 'UPDATE_SETTINGS', settings: { enabled: false } });
  await expect(browse.locator('[data-sc-root]')).toHaveCount(0);
  await command(options, { type: 'UPDATE_SETTINGS', settings: { enabled: true } });
  await expect(browse.locator('.badge:visible')).toHaveCount(3);
  expect(requests.length).toBe(count);
  // SPA playback surfaces fail closed and reattach only on eligible browse pages.
  await browse.evaluate(() => history.pushState(null, '', '/watch/123'));
  await expect(browse.locator('[data-sc-root]')).toHaveCount(0);
  await browse.evaluate(() => history.pushState(null, '', '/browse'));
  await expect(browse.locator('.badge:visible')).toHaveCount(3);
  await browse.close(); await correction.close();
});

test('age-aware caches avoid repeated fetches for a week or month and deduplicate refreshes', async () => {
  async function age(days: number, year: string): Promise<void> {
    await options.evaluate(async ({ days, year }) => await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('stream-companion');
      open.onerror = () => reject(new Error('Fixture database failed'));
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('ratings', 'readwrite');
        const store = tx.objectStore('ratings');
        const key = JSON.stringify(['omdb', 'imdb', 'imdb', 'tt1234567']);
        const request = store.get(key);
        request.onsuccess = () => {
          const entry = request.result;
          entry.value.fetchedAt = Date.now() - days * 86400000;
          entry.value.year = year; store.put(entry);
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(new Error('Fixture cache update failed')); };
      };
    }), { days, year });
  }
  const browse = await context.newPage();
  const count = requests.length;
  await age(20, '2020');
  await browse.goto('https://www.netflix.com/browse');
  await expect(browse.locator('.badge:visible').filter({ hasText: '8.2' })).toHaveCount(2);
  expect(requests.length).toBe(count);
  await age(6, String(new Date().getUTCFullYear())); await browse.reload();
  await expect(browse.locator('.badge:visible').filter({ hasText: '8.2' })).toHaveCount(2);
  expect(requests.length).toBe(count);
  await age(8, String(new Date().getUTCFullYear())); await browse.reload();
  await expect(browse.locator('.badge:visible').filter({ hasText: '8.2' })).toHaveCount(2);
  expect(requests.length).toBe(count + 1);
  await age(31, '2020'); await browse.reload();
  await expect(browse.locator('.badge:visible').filter({ hasText: '8.2' })).toHaveCount(2);
  expect(requests.length).toBe(count + 2);
  await browse.close();
});

test('cache clear preserves matches, usage and cooldown; invalid messages stay local', async () => {
  const before = await command<{ requests24h: number; mappings: number }>(options, { type: 'GET_STATUS' });
  await command(options, { type: 'CLEAR_RATING_CACHE' });
  const after = await command<{ requests24h: number; mappings: number; ratings: number }>(options, { type: 'GET_STATUS' });
  expect(after.requests24h).toBe(before.requests24h); expect(after.mappings).toBe(before.mappings); expect(after.ratings).toBe(0);
  const count = requests.length;
  const rejected = await options.evaluate(async () => await chrome.runtime.sendMessage({ protocol: 1, type: 'LOOKUP', observation: { ref: { platformId: 'netflix', titleId: '1' }, displayTitle: 'x', mediaType: 'movie', adapterVersion: 1 }, url: 'https://evil.test' }));
  expect(rejected.ok).toBe(false); expect(requests.length).toBe(count);
  providerMode = 'quota';
  await expect(command(options, { type: 'TEST_API_KEY' })).rejects.toThrow('paused');
  const quotaCount = requests.length;
  await command(options, { type: 'CLEAR_RATING_CACHE' });
  await expect(command(options, { type: 'TEST_API_KEY' })).rejects.toThrow('cooldown');
  expect(requests.length).toBe(quotaCount);
});

test('browser and worker restart preserve saved choices, key accounting and provider circuit', async () => {
  const before = await command<{ requests24h: number; mappings: number }>(options, { type: 'GET_STATUS' });
  await context.close();
  await launch();
  const after = await command<{ requests24h: number; mappings: number; keyConfigured: boolean; provider: { kind: string } }>(options, { type: 'GET_STATUS' });
  expect(after.requests24h).toBe(before.requests24h);
  expect(after.mappings).toBe(before.mappings); expect(after.mappings).toBe(2);
  expect(after.keyConfigured).toBe(true); expect(after.provider.kind).toBe('paused');
  const requestCount = requests.length;
  await expect(command(options, { type: 'TEST_API_KEY' })).rejects.toThrow('cooldown');
  expect(requests.length).toBe(requestCount);
});

test('settings remain usable at narrow width, zoom and forced colours', async () => {
  await options.setViewportSize({ width: 420, height: 900 });
  await options.reload();
  await expect(options.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await options.screenshot({ path: 'test-results/settings-narrow.png', fullPage: true });
  await options.setViewportSize({ width: 1280, height: 900 });
  await options.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await options.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expect(options.locator('#api-key')).toBeVisible();
});
