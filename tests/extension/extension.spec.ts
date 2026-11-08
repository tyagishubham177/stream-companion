import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Reply, SearchResult, TitleObservation } from '../../src/shared/contracts';
import type { MatchEvent } from '../../src/background/matching-log';
import type { MarksSnapshot, MarkMutation } from '../../src/shared/marks';

interface MatchingExport { events: MatchEvent[]; summary: { confirmed: number; confirmedFirstResults: number } }

let context: BrowserContext;
let base: string;
let options: Page;
let profile: string;
let requests: URL[] = [];
const identityRequests: URL[] = [];
const publicTitleRequests: Array<{ url: URL; headers: Record<string, string>; worker: boolean }> = [];
const networkFailures: Array<{ host: string; method: string; error: string | null }> = [];
let providerMode: 'normal' | 'quota' = 'normal';
const editionFixtures = [
  { id: '1006', title: 'Fixture Revenge (Raw & Undekha)', base: 'Fixture Revenge', candidate: 'Fixture: Revenge', imdbId: 'tt4000006', director: 'Director Fixture', actors: 'Actor One, Actor Two, Actor Three', total: 1 },
  { id: '1007', title: 'Fixture Counterfeit (Extended Cut)', base: 'Fixture Counterfeit', candidate: 'Fixture: Counterfeit', imdbId: 'tt4000007', director: 'Director Other', actors: 'Actor One, Actor Two, Actor Three', total: 1 },
  { id: '1008', title: 'Fixture Castless (Uncut)', base: 'Fixture Castless', candidate: 'Fixture: Castless', imdbId: 'tt4000008', director: 'Director Fixture', actors: 'Actor One, Actor Three', total: 1 },
  { id: '1009', title: 'Fixture Legacy (Raw & Undekha)', base: 'Fixture Legacy', candidate: 'Fixture: Legacy II', imdbId: 'tt4000009', director: 'Director Fixture', actors: 'Actor One, Actor Two, Actor Three', total: 1 },
  { id: '1010', title: 'Fixture Hidden (Extended Edition)', base: 'Fixture Hidden', candidate: 'Fixture: Hidden', imdbId: 'tt4000010', director: 'Director Fixture', actors: 'Actor One, Actor Two, Actor Three', total: 2 },
];
const details = (id: string) => {
  const edition = editionFixtures.find(fixture => fixture.imdbId === id);
  if (edition) return { Response: 'True', Title: edition.candidate, Year: '2026', Type: 'movie', imdbID: id,
    imdbRating: '9.2', imdbVotes: '1,234', Director: edition.director, Actors: edition.actors };
  return { Response: 'True', Title: id === 'tt4000004' ? 'Fixture Hindi Film' : id === 'tt0133093' ? 'Fixture Reference' : id === 'tt7654321' ? 'Fixture Dunes' : 'Fixture Orbit',
  Year: id === 'tt4000004' ? '2012' : id === 'tt0133093' ? '1999' : '2020', Type: 'movie', imdbID: id,
  imdbRating: id === 'tt4000004' ? '9.1' : id === 'tt7654321' ? 'N/A' : '8.2', imdbVotes: '1,234' };
};

async function command<T>(page: Page, request: object): Promise<T> {
  const reply = await page.evaluate(async request => await chrome.runtime.sendMessage({ protocol: 1, ...request }), request) as Reply<T>;
  if (!reply.ok) throw new Error(reply.error); return reply.value;
}
async function showOptions(worker: Worker): Promise<void> {
  // Installation may already be opening settings. Use the same public action
  // instead of racing it with a second navigation to the options page.
  await worker.evaluate(async () => await chrome.runtime.openOptionsPage());
  await expect.poll(() => context.pages().some(page => page.url() === `${base}/options.html`)).toBe(true);
  options = context.pages().find(page => page.url() === `${base}/options.html`)!;
  await expect(options.locator('#save-key')).toBeEnabled();
}
async function launch(): Promise<void> {
  const extensionPath = path.resolve('dist');
  const helperPath = path.join(profile, 'test-helper-extension');
  await mkdir(helperPath, { recursive: true });
  // This helper exists only inside the disposable test profile. It can
  // re-enable the target after Chromium disables it on runtime.reload(),
  // without adding management permissions to the product or losing storage.
  await writeFile(path.join(helperPath, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'Stream Companion isolated test helper', version: '1.0.0', permissions: ['management'],
    background: { service_worker: 'test-helper.js' } }));
  await writeFile(path.join(helperPath, 'test-helper.js'),
    'chrome.runtime.onInstalled.addListener(() => {}); setInterval(() => chrome.runtime.getPlatformInfo(), 20000);');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionPath},${helperPath}`, `--load-extension=${extensionPath},${helperPath}`,
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
      const query = url.searchParams.get('s');
      if (query === 'Fixture Paged Search') {
        const page = Number(url.searchParams.get('page'));
        const start = page === 2 ? 11 : 1;
        const length = page === 2 ? 2 : 10;
        return route.fulfill({ json: { Response: 'True', totalResults: '12', Search: Array.from({ length }, (_, index) => ({
          Title: `Fixture Page Result ${start + index}`, Year: '2020', Type: 'movie', imdbID: `tt${6000000 + start + index}`,
        })) } });
      }
      const edition = editionFixtures.find(fixture => fixture.title === query || fixture.base === query);
      if (edition) {
        expect(url.searchParams.get('y')).toBe('2026'); expect(url.searchParams.get('type')).toBe('movie');
        if (query === edition.title) return route.fulfill({ json: { Response: 'False', Error: 'Movie not found!' } });
        return route.fulfill({ json: { Response: 'True', totalResults: String(edition.total), Search: [
          { Title: edition.candidate, Year: '2026', Type: 'movie', imdbID: edition.imdbId },
        ] } });
      }
      if (query === 'Fixture Hindi Film' || query === 'Fixture Remake') {
        expect(url.searchParams.get('y')).toBe('2012'); expect(url.searchParams.get('type')).toBe('movie');
        return route.fulfill({ json: { Response: 'True', totalResults: '1', Search: [{
          Title: query, Year: query === 'Fixture Remake' ? '2019' : '2012', Type: 'movie',
          imdbID: query === 'Fixture Remake' ? 'tt4000005' : 'tt4000004',
        }] } });
      }
      return route.fulfill({ json: id ? details(id) : { Response: 'True', totalResults: '2', Search: [
        { Title: 'Fixture Orbit', Year: '2020', Type: 'movie', imdbID: 'tt1234567' },
        { Title: 'Fixture Orbit', Year: '1990', Type: 'movie', imdbID: 'tt9999999' }
      ] } });
    }
    if (url.hostname === 'www.netflix.com') {
      const titleId = url.pathname.match(/^\/(?:in\/)?title\/(\d+)$/)?.[1];
      if (titleId) {
        const headers = await route.request().allHeaders();
        publicTitleRequests.push({ url, headers, worker: !!route.request().serviceWorker() });
        expect(headers.cookie).toBeUndefined(); expect(headers.authorization).toBeUndefined(); expect(headers.referer).toBeUndefined();
        expect(url.searchParams.has('apikey')).toBe(false); expect(JSON.stringify(headers)).not.toContain('fixture_only');
        const edition = editionFixtures.find(fixture => fixture.id === titleId);
        if (!edition && titleId !== '1004' && titleId !== '1005') return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Unavailable fixture title</h1>' });
        const title = edition?.title ?? (titleId === '1004' ? 'Fixture Hindi Film' : 'Fixture Remake');
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org', '@type': 'Movie', url: url.href, name: title,
          ...(edition ? { directors: [{ '@type': 'Person', name: 'Director Fixture' }],
            actors: [{ '@type': 'Person', name: 'Actor One' }, { '@type': 'Person', name: 'Actor Two' }] } : {}),
        })}</script></head><body><div data-uia="metadata"><h2>${title}</h2><ul><li>${edition ? '2026' : '2012'}</li><li>2h</li></ul></div></body></html>` });
      }
      return route.fulfill({ contentType: 'text/html', body: await readFile('tests/fixtures/browse.html', 'utf8') });
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') return route.abort();
    return route.continue();
  });
  let worker = context.serviceWorkers().find(worker => new URL(worker.url()).pathname === '/background.js');
  if (!worker) worker = await context.waitForEvent('serviceworker', worker => new URL(worker.url()).pathname === '/background.js');
  base = `chrome-extension://${new URL(worker.url()).hostname}`;
  await showOptions(worker);
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
  expect(await badges.first().evaluate(button => (button.getRootNode() as ShadowRoot).activeElement === button)).toBe(true);
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
  const correctionId = new URL(correction.url()).searchParams.get('context');
  const matchingLog = await command<MatchingExport>(options, { type: 'EXPORT_MATCHING_LOG' });
  const chain = matchingLog.events.filter(event => event.sessionId === correctionId);
  expect(chain.map(event => event.kind)).toEqual(['opened', 'search', 'preview', 'confirmed']);
  const confirmed = chain.find(event => event.kind === 'confirmed')!;
  expect(confirmed.selection).toMatchObject({ query: 'Fixture Orbit', page: 1, position: 1, rank: 1, total: 2 });
  expect(confirmed.automatic?.outcome).toEqual({ kind: 'rated', imdbId: 'tt1234567' });
  expect(confirmed.automatic?.id).toBe(chain[0].automatic?.id);
  expect(confirmed.candidate?.id).toBe('tt1234567');
  const aggregate = await command(options, { type: 'EXPORT_DIAGNOSTICS' });
  expect(JSON.stringify(aggregate)).not.toMatch(/fixture_only|Fixture Orbit|tt1234567|sessionId|searchId/);
  expect(JSON.stringify(matchingLog)).not.toMatch(/fixture_only|apikey|authorization|documentId|tabId/);
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

test('matching history links unresolved titles to confirmed choices and rejects invalid labels', async () => {
  // All storage below belongs to the disposable synthetic profile. Preserve earlier fixture
  // identities so later scrolling/cache tests continue checking the same four identities.
  const snapshot = await options.evaluate(async () => await new Promise<{ mappings: unknown[]; epoch: unknown }>((resolve, reject) => {
    const open = indexedDB.open('stream-companion'); open.onerror = () => reject(new Error('Fixture database failed'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['mappings', 'state']);
      const mappings = tx.objectStore('mappings').getAll(), epoch = tx.objectStore('state').get('mappingEpoch');
      tx.oncomplete = () => { db.close(); resolve({ mappings: mappings.result, epoch: epoch.result }); };
      tx.onerror = () => { db.close(); reject(new Error('Fixture snapshot failed')); };
    };
  }));
  const pages: Page[] = [];
  const observation: TitleObservation = { ref: { platformId: 'netflix', titleId: '1201' }, displayTitle: 'Fixture Manual Missing', mediaType: 'unknown', adapterVersion: 2 };
  const exportLog = () => command<MatchingExport>(options, { type: 'EXPORT_MATCHING_LOG' });
  async function seedContext(id: string, titleId: string): Promise<Page> {
    await options.evaluate(async ({ id, observation, titleId }) => await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('stream-companion'); open.onerror = () => reject(new Error('Fixture database failed'));
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction(['contexts', 'state'], 'readwrite');
        const epoch = tx.objectStore('state').get('mappingEpoch');
        epoch.onsuccess = () => tx.objectStore('contexts').put({ key: id, value: { id,
          observation: { ...observation, ref: { ...observation.ref, titleId } }, revision: 0,
          resetEpoch: epoch.result?.value ?? 0, expiresAt: Date.now() + 1800000 } });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(new Error('Fixture context failed')); };
      };
    }), { id, observation, titleId });
    const page = await context.newPage(); pages.push(page); await page.goto(`${base}/correction.html?context=${id}`);
    await expect(page.locator('#correction-workspace')).toBeVisible(); return page;
  }
  async function updateFixture(store: 'contexts' | 'mappings', key: string, patch: object): Promise<void> {
    await options.evaluate(async ({ store, key, patch }) => await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('stream-companion'); open.onerror = () => reject(new Error('Fixture database failed'));
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction(store, 'readwrite'), table = tx.objectStore(store), request = table.get(key);
        request.onsuccess = () => table.put({ key, value: { ...(request.result?.value ?? {}), ...patch } });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(new Error('Fixture update failed')); };
      };
    }), { store, key, patch });
  }
  try {
    const browse = await context.newPage(); pages.push(browse); await browse.goto('https://www.netflix.com/browse');
    await browse.locator('#row').evaluate(row => {
      row.innerHTML = '<div class="tile" id="manual-missing"><a data-uia="standard-card" aria-label="Fixture Manual Missing" href="/browse?jbv=1201">Fixture Manual Missing</a></div>';
    });
    const missingBadge = browse.locator('#manual-missing [data-sc-root="badge"] .badge');
    await expect(missingBadge).toHaveText('IMDb —');
    await missingBadge.click();
    const newPage = context.waitForEvent('page');
    await browse.getByRole('button', { name: 'Find a match', exact: true }).click();
    const correction = await newPage; pages.push(correction); await correction.waitForLoadState();
    const contextId = new URL(correction.url()).searchParams.get('context')!;
    await correction.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(correction.locator('#results li')).toHaveCount(2);
    await correction.getByRole('button', { name: 'Preview Fixture Orbit, 2020', exact: true }).click();
    await expect(correction.locator('#preview-score')).toHaveText('8.2');
    expect((await exportLog()).events.filter(event => event.sessionId === contextId && event.kind === 'confirmed')).toEqual([]);
    // Starting another search cannot rewrite the provenance of an already displayed preview.
    await correction.locator('#query').fill('Another Fixture Search');
    await correction.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(correction.locator('#search-summary')).toContainText('2 candidates');
    await correction.getByRole('button', { name: 'Confirm this match', exact: true }).click();
    await expect(correction.locator('#notice')).toContainText('Match saved');
    await expect(missingBadge).toHaveText('★ IMDb 8.2');
    const confirmed = (await exportLog()).events.find(event => event.sessionId === contextId && event.kind === 'confirmed')!;
    expect(confirmed.selection).toMatchObject({ query: observation.displayTitle, page: 1, position: 1, rank: 1 });
    expect(confirmed.automatic?.outcome).toMatchObject({ kind: 'needs_match', reason: 'not_found' });
    expect(confirmed.automatic?.steps.some(step => step.stage === 'wikidata' && step.outcome === 'missing')).toBe(true);
    expect(confirmed.automatic?.steps.some(step => step.stage === 'netflix_metadata' && step.outcome === 'missing')).toBe(true);
    await expect(command(correction, { type: 'CONFIRM_MATCH', contextId, previewId: crypto.randomUUID() })).rejects.toThrow('expired');
    expect((await exportLog()).events.filter(event => event.sessionId === contextId && event.kind === 'confirmed')).toHaveLength(1);
    await browse.close();

    const directId = crypto.randomUUID(), direct = await seedContext(directId, '1202');
    const directPreview = await command<{ previewId: string }>(direct, { type: 'PREVIEW_MATCH', contextId: directId, input: 'https://www.imdb.com/title/tt1234567/?ref_=FIXTURE_PRIVATE' });
    await command(direct, { type: 'CONFIRM_MATCH', contextId: directId, previewId: directPreview.previewId });
    const directConfirmed = (await exportLog()).events.find(event => event.sessionId === directId && event.kind === 'confirmed')!;
    expect(directConfirmed.selection).toBeUndefined();
    expect(JSON.stringify(await exportLog())).not.toMatch(/FIXTURE_PRIVATE|fixture_only|apikey|authorization|documentId|tabId/);

    const pagedId = crypto.randomUUID(), paged = await seedContext(pagedId, '1203');
    const pageTwo = await command<SearchResult & { searchId: string }>(paged, { type: 'SEARCH_MATCHES', contextId: pagedId, query: 'Fixture Paged Search', page: 2 });
    expect(pageTwo.candidates).toHaveLength(2);
    const pagedPreview = await command<{ previewId: string }>(paged, { type: 'PREVIEW_MATCH', contextId: pagedId, input: pageTwo.candidates[1].id, searchId: pageTwo.searchId });
    await command(paged, { type: 'CONFIRM_MATCH', contextId: pagedId, previewId: pagedPreview.previewId });
    expect((await exportLog()).events.find(event => event.sessionId === pagedId && event.kind === 'confirmed')?.selection)
      .toMatchObject({ query: 'Fixture Paged Search', page: 2, position: 2, rank: 12, total: 12 });

    await options.getByRole('button', { name: 'Review matching log', exact: true }).click();
    await expect(options.locator('#matching-log-summary')).toContainText('4 confirmed matches');
    await options.locator('#matching-log-review summary').click();
    await expect(options.locator('#matching-log-preview')).toContainText('Fixture Manual Missing');
    const reviewed = await options.locator('#matching-log-preview').textContent();
    const downloadEvent = options.waitForEvent('download');
    await options.getByRole('button', { name: 'Download matching log', exact: true }).click();
    const downloaded = await downloadEvent;
    expect(downloaded.suggestedFilename()).toMatch(/^stream-companion-matching-log-\d{4}-\d{2}-\d{2}\.json$/);
    expect(await readFile((await downloaded.path())!, 'utf8')).toBe(reviewed);
    await options.locator('#matching-log-review').screenshot({ path: 'test-results/matching-log-review.png' });

    const staleId = crypto.randomUUID(), stale = await seedContext(staleId, '1204');
    const stalePreview = await command<{ previewId: string }>(stale, { type: 'PREVIEW_MATCH', contextId: staleId, input: 'tt1234567' });
    await updateFixture('mappings', JSON.stringify(['netflix', '1204']), { revision: 1 });
    await expect(command(stale, { type: 'CONFIRM_MATCH', contextId: staleId, previewId: stalePreview.previewId })).rejects.toThrow('match changed');
    const expiredId = crypto.randomUUID(), expired = await seedContext(expiredId, '1205');
    const expiredPreview = await command<{ previewId: string }>(expired, { type: 'PREVIEW_MATCH', contextId: expiredId, input: 'tt1234567' });
    await updateFixture('contexts', expiredId, { expiresAt: Date.now() - 1 });
    await expect(command(expired, { type: 'CONFIRM_MATCH', contextId: expiredId, previewId: expiredPreview.previewId })).rejects.toThrow('expired');
    const resetId = crypto.randomUUID(), reset = await seedContext(resetId, '1206');
    const resetPreview = await command<{ previewId: string }>(reset, { type: 'PREVIEW_MATCH', contextId: resetId, input: 'tt1234567' });
    await command(options, { type: 'RESET_MATCHES' });
    await expect(command(reset, { type: 'CONFIRM_MATCH', contextId: resetId, previewId: resetPreview.previewId })).rejects.toThrow('match changed');
    const invalidIds = new Set<string>([staleId, expiredId, resetId]);
    expect((await exportLog()).events.filter(event => event.kind === 'confirmed' && invalidIds.has(event.sessionId ?? ''))).toEqual([]);

    const clearId = crypto.randomUUID(), clear = await seedContext(clearId, '1207');
    const clearPreview = await command<{ previewId: string }>(clear, { type: 'PREVIEW_MATCH', contextId: clearId, input: 'tt1234567' });
    const before = await command<{ mappings: number; ratings: number; requests24h: number; keyConfigured: boolean }>(options, { type: 'GET_STATUS' });
    options.once('dialog', dialog => { void dialog.accept(); });
    await options.getByRole('button', { name: 'Clear matching log', exact: true }).click();
    await expect(options.locator('#notice')).toContainText('Matching log cleared');
    await expect(options.locator('#matching-log-review')).toBeHidden();
    await expect(options.locator('#matching-log-preview')).toHaveText('');
    expect((await exportLog()).events).toEqual([]);
    const after = await command<typeof before>(options, { type: 'GET_STATUS' });
    for (const field of ['mappings', 'ratings', 'requests24h', 'keyConfigured'] as const) expect(after[field]).toBe(before[field]);
    await expect(command(clear, { type: 'CONFIRM_MATCH', contextId: clearId, previewId: clearPreview.previewId })).rejects.toThrow('expired');
    expect((await exportLog()).events).toEqual([]);
  } finally {
    for (const page of pages) if (!page.isClosed()) await page.close();
    await options.evaluate(async snapshot => await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('stream-companion'); open.onerror = () => reject(new Error('Fixture database failed'));
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction(['mappings', 'state', 'contexts'], 'readwrite');
        tx.objectStore('mappings').clear();
        for (const entry of snapshot.mappings) tx.objectStore('mappings').put(entry);
        if (snapshot.epoch) tx.objectStore('state').put(snapshot.epoch); else tx.objectStore('state').delete('mappingEpoch');
        tx.objectStore('contexts').clear();
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(new Error('Fixture restore failed')); };
      };
    }), snapshot);
  }
});

test('badges follow native scrolling and transforms without flicker, focus jumps or playback', async () => {
  const browse = await context.newPage(); await browse.goto('https://www.netflix.com/browse');
  const card = browse.locator('a[data-uia="standard-card"]').first();
  const badge = browse.locator('[data-sc-root="badge"] .badge').first();
  await expect(badge).toHaveText('★ IMDb 8.2');
  await expect(browse.locator('[data-sc-root="badge"]')).toHaveCount(3);
  expect(await badge.evaluate(button => !(button.getRootNode() as ShadowRoot).host.closest('a'))).toBe(true);
  await browse.evaluate(() => {
    document.querySelector<HTMLElement>('main')!.style.minHeight = '2400px';
    const row = document.querySelector<HTMLElement>('#row')!;
    row.style.width = '520px'; row.style.overflowX = 'auto';
    // A platform focus handler may scroll or open the focused card. Automatic
    // dismissal must not invoke it, even when a panel control owned focus.
    (window as unknown as { cardFocusCount: number }).cardFocusCount = 0;
    document.addEventListener('focus', event => {
      if (event.target instanceof Element && event.target.matches('a[data-uia]')) {
        (window as unknown as { cardFocusCount: number }).cardFocusCount++;
      }
    }, true);
  });
  const providerCount = requests.length;
  const identityCount = identityRequests.length;
  const samples = await card.evaluate(async tile => {
    const wrapper = tile.parentElement!;
    const row = wrapper.parentElement!;
    const button = wrapper.querySelector('[data-sc-root="badge"]')!.shadowRoot!.querySelector<HTMLButtonElement>('.badge')!;
    const results: Array<{ x: number; y: number; text: string | null; hidden: boolean }> = [];
    for (let frame = 0; frame < 40; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => {
        // Read in the same frame as the platform movement: a fixed portal that
        // catches up in another rAF can look correct only after scrolling stops.
        window.scrollTo(0, frame * 2);
        row.scrollLeft = frame * 0.75;
        wrapper.style.transform = `translateX(${frame * 0.375}px)`;
        const anchorRect = tile.getBoundingClientRect();
        const badgeRect = button.getBoundingClientRect();
        results.push({ x: anchorRect.right - badgeRect.right, y: badgeRect.top - anchorRect.top,
          text: button.textContent, hidden: button.hidden || getComputedStyle(button).display === 'none' });
        resolve();
      }));
    }
    return results;
  });
  expect(samples).toHaveLength(40);
  for (const sample of samples) {
    expect(sample.x).toBeCloseTo(8, 1); expect(sample.y).toBeCloseTo(8, 1);
    expect(sample.hidden).toBe(false); expect(sample.text).toBe('★ IMDb 8.2');
  }
  expect(requests.length).toBe(providerCount); expect(identityRequests.length).toBe(identityCount);

  await badge.click(); await expect(browse.getByRole('dialog')).toBeVisible();
  await browse.keyboard.press('Escape');
  await expect(browse.getByRole('dialog')).toHaveCount(0);
  expect(await badge.evaluate(button => (button.getRootNode() as ShadowRoot).activeElement === button)).toBe(true);
  await badge.press('Enter'); await expect(browse.getByRole('dialog')).toBeVisible();
  await browse.evaluate(() => window.scrollTo(0, 100));
  await expect(browse.getByRole('dialog')).toHaveCount(0);
  expect(await browse.evaluate(() => ({ y: scrollY, focus: (window as unknown as { cardFocusCount: number }).cardFocusCount })))
    .toEqual({ y: 100, focus: 0 });
  await badge.press('Space'); await expect(browse.getByRole('dialog')).toBeVisible();
  await browse.keyboard.press('Escape');
  await badge.dblclick();
  expect(await browse.evaluate(() => (window as unknown as { playbackCount: number }).playbackCount)).toBe(0);

  // The second card's right-corner badge is outside the nested scroller. It
  // must be clipped by that scroller rather than float over adjacent content.
  expect(await browse.evaluate(() => {
    const row = document.querySelector('#row')!;
    const host = row.children[1].querySelector('[data-sc-root="badge"]')!;
    const button = host.shadowRoot!.querySelector('.badge')!;
    const rect = button.getBoundingClientRect(); const clip = row.getBoundingClientRect();
    return rect.right > clip.right && !document.elementsFromPoint(rect.right - 2, rect.top + 10).includes(host);
  })).toBe(true);

  await browse.locator('.tile').nth(2).evaluate(wrapper => (wrapper as HTMLElement).style.setProperty('position', 'sticky', 'important'));
  await command(options, { type: 'UPDATE_SETTINGS', settings: { enabled: false } });
  await expect(browse.locator('[data-sc-root]')).toHaveCount(0);
  expect(await browse.locator('.tile').evaluateAll(wrappers => wrappers.slice(0, 2).every(wrapper => (wrapper as HTMLElement).style.position === ''))).toBe(true);
  expect(await browse.locator('.tile').nth(2).evaluate(wrapper => ({ value: (wrapper as HTMLElement).style.position,
    priority: (wrapper as HTMLElement).style.getPropertyPriority('position') }))).toEqual({ value: 'sticky', priority: 'important' });
  // The platform's own style changes survive removal of extension mounts.
  expect(await card.evaluate(tile => tile.parentElement!.style.transform)).toBe('translateX(14.625px)');
  await command(options, { type: 'UPDATE_SETTINGS', settings: { enabled: true } });
  await expect(badge).toHaveText('★ IMDb 8.2');
  await expect(browse.locator('[data-sc-root="badge"]')).toHaveCount(3);
  expect(requests.length).toBe(providerCount); expect(identityRequests.length).toBe(identityCount);
  await browse.close();
});

test('hover previews rate the title instead of its Play episode and clear conflicting identities', async () => {
  const browse = await context.newPage(); await browse.goto('https://www.netflix.com/browse');
  await expect(browse.locator('[data-sc-root="badge"] .badge').first()).toHaveText('★ IMDb 8.2');
  const providerCount = requests.length;
  const identityCount = identityRequests.length;
  await browse.evaluate(() => {
    const preview = document.createElement('div'); preview.id = 'hover-preview';
    preview.dataset.uia = 'modal-motion-container-MINI_MODAL'; preview.setAttribute('role', 'dialog');
    preview.style.cssText = 'position:absolute;top:450px;left:480px;width:360px;height:240px;background:#345';
    preview.innerHTML = '<a href="/title/1001?dpRightClick=1"><div data-uia="previewModal--player_container"><img alt="Fixture Orbit" width="360" height="200" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'360\' height=\'200\'%3E%3C/svg%3E"></div></a><a href="/watch/999999">Play</a><button type="button" aria-label="Close preview">×</button>';
    preview.addEventListener('click', event => {
      if ((event.target as Element).closest('a')) {
        (window as unknown as { playbackCount: number }).playbackCount++; event.preventDefault();
      }
    }, true);
    document.body.append(preview);
  });
  const preview = browse.locator('#hover-preview');
  const badge = preview.locator('[data-sc-root="badge"] .badge');
  await expect(badge).toHaveText('★ IMDb 8.2');
  await expect(browse.locator('[data-sc-root="badge"]')).toHaveCount(4);
  expect(await badge.evaluate(button => {
    const container = (button.getRootNode() as ShadowRoot).host.parentElement!;
    const anchor = container.getBoundingClientRect(), rect = button.getBoundingClientRect();
    return { x: rect.left - anchor.left, y: rect.top - anchor.top };
  })).toEqual({ x: 8, y: 8 });
  expect(requests.length).toBe(providerCount); expect(identityRequests.length).toBe(identityCount);
  // The preview is already present before the new control mounts. It must not
  // depend on receiving a later mouseenter, and its menu must share Netflix's
  // modal/hover owner rather than falling outside the focus boundary.
  const mark = preview.locator('[data-sc-root="marks"] button');
  await expect(mark).toHaveCSS('opacity', '1');
  await mark.click();
  const marksMenu = preview.getByRole('menu', { name: 'Fixture Orbit', exact: true });
  await expect(marksMenu).toBeVisible();
  await marksMenu.getByRole('menuitemradio', { name: 'Want to watch', exact: true }).click();
  await expect(mark).toHaveAttribute('aria-label', /Want to watch/);
  await browse.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(mark).toHaveAttribute('aria-label', /No marks/);
  await badge.click(); await expect(browse.getByRole('dialog').filter({ hasText: 'IMDb rating' })).toBeVisible();
  await browse.keyboard.press('Escape');
  await badge.press('Space'); await browse.keyboard.press('Escape');
  expect(await browse.evaluate(() => (window as unknown as { playbackCount: number }).playbackCount)).toBe(0);
  await preview.evaluate(container => {
    const conflicting = document.createElement('a'); conflicting.id = 'conflicting-title'; conflicting.href = '/title/1002';
    conflicting.textContent = 'Conflicting recycled title'; container.append(conflicting);
  });
  await expect(badge).toHaveCount(0);
  await preview.locator('#conflicting-title').evaluate(link => link.remove());
  await expect(badge).toHaveText('★ IMDb 8.2');
  expect(requests.length).toBe(providerCount); expect(identityRequests.length).toBe(identityCount);
  await preview.evaluate(container => container.remove());
  await expect(browse.locator('[data-sc-root="badge"]')).toHaveCount(3);
  await browse.close();
});

test('public movie metadata fills missing Wikidata matches automatically and rejects remakes', async () => {
  const browse = await context.newPage(); await browse.goto('https://www.netflix.com/browse');
  await expect(browse.locator('[data-sc-root="badge"] .badge').first()).toHaveText('★ IMDb 8.2');
  await context.addCookies([{ name: 'fixture_netflix_session', value: 'synthetic_session_only', domain: '.netflix.com', path: '/' }]);
  async function addCard(id: string, title: string, left = 48): Promise<void> {
    await browse.evaluate(({ id, title, left }) => {
      const wrapper = document.createElement('div'); wrapper.id = `fallback-${id}`; wrapper.className = 'tile';
      wrapper.style.cssText = `position:absolute;top:450px;left:${left}px;width:280px;height:165px`;
      const anchor = document.createElement('a'); anchor.dataset.uia = 'standard-card';
      anchor.href = `/browse?jbv=${id}`; anchor.setAttribute('aria-label', title); anchor.textContent = title;
      wrapper.append(anchor); document.querySelector('main')!.append(wrapper);
    }, { id, title, left });
  }
  const providerBefore = requests.length;
  const publicBefore = publicTitleRequests.length;
  const pagesBefore = context.pages().length;
  await addCard('1004', 'Fixture Hindi Film');
  const badge = browse.locator('#fallback-1004 [data-sc-root="badge"] .badge');
  await expect(badge).toHaveText('★ IMDb 9.1');
  const searches = requests.slice(providerBefore).filter(url => url.searchParams.has('s'));
  expect(searches).toHaveLength(1); expect(searches[0].searchParams.get('s')).toBe('Fixture Hindi Film');
  expect(searches[0].searchParams.get('y')).toBe('2012'); expect(searches[0].searchParams.get('type')).toBe('movie');
  expect(requests.slice(providerBefore).filter(url => url.searchParams.get('i') === 'tt4000004')).toHaveLength(1);
  const fetched = publicTitleRequests.slice(publicBefore);
  expect(fetched).toHaveLength(1); expect(fetched[0].url.pathname).toBe('/in/title/1004'); expect(fetched[0].worker).toBe(true);
  expect(fetched[0].headers.cookie).toBeUndefined(); expect(fetched[0].headers.referer).toBeUndefined();
  expect(browse.url()).toBe('https://www.netflix.com/browse'); expect(context.pages()).toHaveLength(pagesBefore);
  expect(await browse.evaluate(() => (window as unknown as { playbackCount: number }).playbackCount)).toBe(0);

  const providerCached = requests.length, publicCached = publicTitleRequests.length, identityCached = identityRequests.length;
  await browse.evaluate(() => {
    const preview = document.createElement('div'); preview.id = 'fallback-preview';
    preview.dataset.uia = 'modal-motion-container-MINI_MODAL'; preview.setAttribute('role', 'dialog');
    preview.style.cssText = 'position:absolute;top:450px;left:480px;width:360px;height:240px';
    preview.innerHTML = '<a href="/title/1004?dpRightClick=1"><div data-uia="previewModal--player_container"><img alt="Fixture Hindi Film" width="360" height="200"></div></a><a href="/watch/999999">Play</a>';
    document.body.append(preview);
  });
  await expect(browse.locator('#fallback-preview [data-sc-root="badge"] .badge')).toHaveText('★ IMDb 9.1');
  expect(requests.length).toBe(providerCached); expect(publicTitleRequests.length).toBe(publicCached);
  expect(identityRequests.length).toBe(identityCached);
  await browse.reload(); await addCard('1004', 'Fixture Hindi Film');
  await expect(badge).toHaveText('★ IMDb 9.1');
  expect(requests.length).toBe(providerCached); expect(publicTitleRequests.length).toBe(publicCached);
  expect(identityRequests.length).toBe(identityCached);

  await addCard('1005', 'Fixture Remake', 400);
  const remake = browse.locator('#fallback-1005 [data-sc-root="badge"] .badge');
  await expect(remake).toHaveText('IMDb —');
  expect(requests.filter(url => url.searchParams.get('s') === 'Fixture Remake')).toHaveLength(1);
  expect(requests.filter(url => url.searchParams.get('i') === 'tt4000005')).toHaveLength(0);
  await expect(remake).not.toHaveText(/9\.1|8\.2/);
  expect(publicTitleRequests.filter(request => request.url.pathname === '/in/title/1005')).toHaveLength(1);
  await context.clearCookies(); await browse.close();
});

test('edition aliases need matching director and two cast members before rating automatically', async () => {
  const browse = await context.newPage(); await browse.goto('https://www.netflix.com/browse');
  await expect(browse.locator('[data-sc-root="badge"] .badge').first()).toHaveText('★ IMDb 8.2');
  const positive = editionFixtures[0];
  // Simulate the prior public cache schema: its title/year remain fresh, but
  // edition matching must upgrade it with credits before using a base alias.
  await options.evaluate(async fixture => await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('stream-companion'); open.onerror = () => reject(new Error('Fixture database failed'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('resolutions', 'readwrite'), now = Date.now();
      tx.objectStore('resolutions').put({ key: JSON.stringify(['netflix-metadata', 'netflix', fixture.id]), value: {
        result: { kind: 'matched', title: fixture.title, mediaType: 'movie', year: 2026, checkedAt: now },
        expiresAt: now + 30 * 86400000,
      } });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(new Error('Fixture legacy cache write failed')); };
    };
  }), positive);
  async function addCard(fixture: typeof positive, left = 48): Promise<void> {
    await browse.evaluate(({ fixture, left }) => {
      const wrapper = document.createElement('div'); wrapper.id = `edition-${fixture.id}`; wrapper.className = 'tile';
      wrapper.style.cssText = `position:absolute;top:450px;left:${left}px;width:280px;height:165px`;
      const anchor = document.createElement('a'); anchor.dataset.uia = 'standard-card';
      anchor.href = `/browse?jbv=${fixture.id}`; anchor.setAttribute('aria-label', fixture.title); anchor.textContent = fixture.title;
      wrapper.append(anchor); document.querySelector('main')!.append(wrapper);
    }, { fixture, left });
  }
  const before = requests.length;
  const publicBefore = publicTitleRequests.length;
  await addCard(positive);
  const badge = browse.locator(`#edition-${positive.id} [data-sc-root="badge"] .badge`);
  await expect(badge).toHaveText('★ IMDb 9.2');
  const editionCalls = requests.slice(before);
  expect(editionCalls.map(url => url.searchParams.get('s')).filter(Boolean)).toEqual([positive.title, positive.base]);
  expect(editionCalls).toHaveLength(3);
  expect(editionCalls[2].searchParams.get('i')).toBe(positive.imdbId);
  expect(publicTitleRequests.slice(publicBefore).map(request => request.url.pathname)).toEqual(['/in/title/1006']);
  const cachedProvider = requests.length, cachedPublic = publicTitleRequests.length, cachedIdentity = identityRequests.length;
  await browse.evaluate(fixture => {
    const preview = document.createElement('div'); preview.id = 'edition-preview';
    preview.dataset.uia = 'modal-motion-container-MINI_MODAL'; preview.setAttribute('role', 'dialog');
    preview.style.cssText = 'position:absolute;top:450px;left:480px;width:360px;height:240px';
    const link = document.createElement('a'); link.href = `/title/${fixture.id}?dpRightClick=1`;
    const player = document.createElement('div'); player.dataset.uia = 'previewModal--player_container';
    const image = document.createElement('img'); image.alt = fixture.title; image.width = 360; image.height = 200;
    player.append(image); link.append(player); preview.append(link); document.body.append(preview);
  }, positive);
  await expect(browse.locator('#edition-preview [data-sc-root="badge"] .badge')).toHaveText('★ IMDb 9.2');
  await browse.reload(); await addCard(positive);
  await expect(badge).toHaveText('★ IMDb 9.2');
  expect(requests.length).toBe(cachedProvider); expect(publicTitleRequests.length).toBe(cachedPublic);
  expect(identityRequests.length).toBe(cachedIdentity);
  for (const fixture of editionFixtures.slice(1)) {
    const start = requests.length;
    await addCard(fixture, 400);
    const rejected = browse.locator(`#edition-${fixture.id} [data-sc-root="badge"] .badge`);
    await expect(rejected).toHaveText('IMDb —');
    const calls = requests.slice(start);
    expect(calls.map(url => url.searchParams.get('s')).filter(Boolean)).toEqual([fixture.title, fixture.base]);
    const shouldReadDetails = fixture.id === '1007' || fixture.id === '1008';
    expect(calls.filter(url => url.searchParams.get('i') === fixture.imdbId)).toHaveLength(shouldReadDetails ? 1 : 0);
    await browse.locator(`#edition-${fixture.id}`).evaluate(wrapper => wrapper.remove());
  }
  const saved = await command<Array<{ ref: { titleId: string } }>>(options, { type: 'LIST_MATCHES' });
  expect(saved.filter(match => editionFixtures.some(fixture => fixture.id === match.ref.titleId)).map(match => match.ref.titleId)).toEqual(['1006']);
  expect(browse.url()).toBe('https://www.netflix.com/browse');
  expect(await browse.evaluate(() => (window as unknown as { playbackCount: number }).playbackCount)).toBe(0);
  await browse.close();
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
  expect(after.mappings).toBe(before.mappings); expect(after.mappings).toBe(4); // Two direct IDs, public metadata and one corroborated edition.
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

test('extension reload retires stale content scripts and offers a single working reconnect action', async () => {
  // Earlier tests deliberately leave the provider circuit paused and clear its
  // cache. Seed durable fake ratings to verify reconnect works from saved data
  // even while fetching is unavailable; this does not reset that circuit.
  await options.evaluate(async () => await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('stream-companion');
    open.onerror = () => reject(new Error('Fixture database failed'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('ratings', 'readwrite');
      for (const [id, title, score] of [['tt1234567', 'Fixture Orbit', 8.2], ['tt7654321', 'Fixture Dunes', null]] as const) {
        tx.objectStore('ratings').put({ key: JSON.stringify(['omdb', 'imdb', 'imdb', id]), value: {
          subject: { namespace: 'imdb', id }, source: 'imdb', provider: 'omdb', title, year: '2020', mediaType: 'movie',
          score, scale: 10, votes: 1234, fetchedAt: Date.now(),
        } });
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(new Error('Fixture cache write failed')); };
    };
  }));
  const before = await command<{ ratings: number; mappings: number; keyConfigured: boolean; requests24h: number }>(options, { type: 'GET_STATUS' });
  expect(before.keyConfigured).toBe(true); expect(before.ratings).toBe(2);
  const browse = await context.newPage();
  const problems: string[] = [];
  browse.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') problems.push(message.text()); });
  browse.on('pageerror', error => problems.push(error.message));
  await browse.goto('https://www.netflix.com/browse');
  await expect(browse.locator('[data-sc-root="badge"] .badge').first()).toHaveText('★ IMDb 8.2');
  const requestCount = requests.length;
  const identityCount = identityRequests.length;
  // Use the actual trusted extension API. The timer lets evaluation return
  // before Chrome destroys the options page and invalidates the old scripts.
  await options.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); });
  const reconnect = browse.locator('[data-sc-root="reconnect"]');
  await expect(reconnect).toHaveCount(1);
  await expect(reconnect.getByRole('button', { name: 'Refresh Netflix', exact: true })).toBeVisible();
  await expect(reconnect.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  await expect(browse.locator('[data-sc-root="badge"], [data-sc-root="ratings"]')).toHaveCount(0);
  expect(await browse.locator('.tile').evaluateAll(wrappers => wrappers.every(wrapper => (wrapper as HTMLElement).style.position === ''))).toBe(true);
  await browse.evaluate(async () => {
    document.querySelector<HTMLElement>('main')!.style.minHeight = '2400px';
    for (let frame = 0; frame < 30; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => {
        window.scrollTo(0, frame * 2);
        document.querySelector('#row')!.classList.toggle('platform-updating', frame % 2 === 0);
        resolve();
      }));
    }
  });
  await expect(reconnect).toHaveCount(1);
  await expect(browse.locator('[data-sc-root="badge"], [data-sc-root="ratings"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  // Chromium disables a command-line-loaded fixture on runtime.reload. The
  // disposable helper uses Chrome's public management API to re-enable the
  // exact same installation without uninstalling it or resetting its data.
  const helper = context.serviceWorkers().find(worker => new URL(worker.url()).pathname === '/test-helper.js');
  expect(helper, 'isolated management helper worker remains available').toBeDefined();
  const restored = await helper!.evaluate(async targetId => {
    const before = await chrome.management.get(targetId);
    if (!before.enabled && !before.mayEnable) throw new Error(`Fixture cannot be enabled: ${before.disabledReason}`);
    if (!before.enabled) await chrome.management.setEnabled(targetId, true);
    const after = await chrome.management.get(targetId);
    return { id: after.id, enabled: after.enabled };
  }, new URL(base).hostname);
  expect(restored).toEqual({ id: new URL(base).hostname, enabled: true });
  let replacement = context.serviceWorkers().find(worker => new URL(worker.url()).pathname === '/background.js');
  if (!replacement) replacement = await context.waitForEvent('serviceworker', worker => new URL(worker.url()).pathname === '/background.js');
  await showOptions(replacement);
  expect((await command<typeof before>(options, { type: 'GET_STATUS' })).keyConfigured).toBe(true);
  await browse.bringToFront();
  const navigation = browse.waitForEvent('load');
  await reconnect.getByRole('button', { name: 'Refresh Netflix', exact: true }).click();
  await navigation;
  await expect(reconnect).toHaveCount(0);
  await expect(browse.locator('[data-sc-root="badge"]')).toHaveCount(3);
  await expect(browse.locator('[data-sc-root="badge"] .badge').first()).toHaveText('★ IMDb 8.2');
  await expect(browse.locator('[data-sc-root="badge"] .badge').nth(1)).toHaveText('IMDb NR');
  expect(problems).toEqual([]);
  expect(requests.length).toBe(requestCount); expect(identityRequests.length).toBe(identityCount);
  const after = await command<typeof before>(options, { type: 'GET_STATUS' });
  expect(after.keyConfigured).toBe(true); expect(after.ratings).toBe(before.ratings);
  expect(after.mappings).toBe(before.mappings); expect(after.requests24h).toBe(before.requests24h);
  await browse.close();
});

test('actual MV3 marks work without a key across search and discovery, survive restart and toggle independently', async () => {
  await options.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
  await options.evaluate(() => { document.documentElement.style.zoom = ''; });
  await command(options, { type: 'UPDATE_SETTINGS', settings: { enabled: true, ratingsEnabled: false, marksEnabled: true, shadeWatched: true, fadePassed: true } });
  await command(options, { type: 'REMOVE_API_KEY' });
  const calls = requests.length;
  const browse = await context.newPage();
  await browse.goto('https://www.netflix.com/search?q=fixture');
  const marks = browse.locator('[data-sc-root="marks"] button');
  await expect(marks).toHaveCount(3);
  await expect(browse.locator('[data-sc-root="badge"]')).toHaveCount(0);
  await marks.first().focus(); await marks.first().press('Enter');
  await browse.getByRole('menuitemcheckbox', { name: 'Watched', exact: true }).click();
  await expect(marks.first()).toHaveAttribute('aria-label', /Watched/);
  await marks.first().click();
  await browse.getByRole('menuitemradio', { name: 'Want to watch', exact: true }).click();
  await expect(marks.first()).toHaveAttribute('aria-label', /Watched.*Want to watch/);
  const snapshot = await command<MarksSnapshot>(options, { type: 'LIST_MARKS' });
  const record = snapshot.marks.find(mark => mark.observation.ref.titleId === '1001')!;
  expect(record).toMatchObject({ watched: true, plan: 'want' });
  // Duplicate cards and cross-tab changes use the same durable title key.
  await expect(marks.nth(2)).toHaveAttribute('aria-label', /Watched.*Want to watch/);
  const titles = await context.newPage(); await titles.goto(`${base}/titles.html`);
  await expect(titles.getByText('Fixture Orbit', { exact: true })).toBeVisible();
  for (const path of ['/latest', '/browse/original-audio', '/browse/audio-description']) {
    await browse.goto('https://www.netflix.com' + path);
    await expect(browse.locator('[data-sc-root="marks"] button').first()).toHaveAttribute('aria-label', /Watched.*Want to watch/);
  }
  const changed = await command<MarkMutation>(titles, { type: 'SET_MARK', observation: record.observation, plan: 'pass', revision: record.revision, epoch: snapshot.epoch });
  await expect(browse.locator('[data-sc-root="marks"] button').first()).toHaveAttribute('aria-label', /Won’t watch/);
  await command(options, { type: 'UPDATE_SETTINGS', settings: { marksEnabled: false } });
  await expect(browse.locator('[data-sc-root="marks"]')).toHaveCount(0);
  expect((await command<MarksSnapshot>(options, { type: 'LIST_MARKS' })).marks).toContainEqual(changed.mark);
  await command(options, { type: 'UPDATE_SETTINGS', settings: { marksEnabled: true } });
  await expect(browse.locator('[data-sc-root="marks"] button').first()).toHaveAttribute('aria-label', /Won’t watch/);
  expect(requests.length).toBe(calls);
  // Diagnostics toggling is independent of stored decisions and normal provider state.
  await command(options, { type: 'UPDATE_SETTINGS', settings: { matchingLogEnabled: false, automaticMatching: false } });
  const settings = await command<{ settings: { matchingLogEnabled: boolean; automaticMatching: boolean } }>(options, { type: 'GET_STATUS' });
  expect(settings.settings).toMatchObject({ matchingLogEnabled: false, automaticMatching: false });
  await titles.screenshot({ path: 'test-results/your-titles.png', fullPage: true });
  await browse.close(); await titles.close();
  await context.close(); await launch();
  const persisted = await command<MarksSnapshot>(options, { type: 'LIST_MARKS' });
  expect(persisted.marks.find(mark => mark.observation.ref.titleId === '1001')).toEqual(changed.mark);
  const restarted = await command<{ keyConfigured: boolean; settings: { ratingsEnabled: boolean; marksEnabled: boolean } }>(options, { type: 'GET_STATUS' });
  expect(restarted.keyConfigured).toBe(false);
  expect(restarted.settings).toMatchObject({ ratingsEnabled: false, marksEnabled: true });
});
