import { chromium, expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ratingsFixture, serveRatingsFixture } from './ratings-fixture';

const grid = Array.from({ length: 48 }, (_, index) => ({
  titleId: String(82001000 + index),
  imdbId: `tt${8100000 + index}`,
  title: `Burst fixture ${index + 1}`,
}));
const browseUrl = 'https://www.netflix.com/browse';
const catalogue = `<!doctype html><html><head><title>Fixture rating burst</title><style>
  body { margin: 20px; }
  main { display: grid; grid-template-columns: repeat(8, 110px); gap: 8px; }
  .tile a { display: block; width: 110px; height: 70px; background: #333; color: #fff; }
</style></head><body><main>${grid.map(({ titleId, title }) => `<div class="tile">
  <a data-uia="standard-card" aria-label="${title}" href="/browse?jbv=${titleId}"></a></div>`).join('')}</main></body></html>`;

test('a cold ratings snapshot can serve 48 visible titles without extension request errors', async ({}, info) => {
  const extension = path.resolve('dist');
  const profile = info.outputPath('chrome-profile');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    viewport: { width: 1240, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost', '--disable-background-networking'] });
  const snapshot = ratingsFixture(grid.map(({ imdbId }) => [imdbId, '7.5']));
  let downloads = 0;
  const unexpectedRequests: string[] = [];
  try {
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url === browseUrl) return route.fulfill({ contentType: 'text/html', body: catalogue });
      if (url === 'https://datasets.imdbws.com/title.ratings.tsv.gz') {
        downloads++;
        // Keep the first lookup active while the content script scans the whole grid.
        await new Promise(resolve => setTimeout(resolve, 8000));
        return serveRatingsFixture(route, snapshot);
      }
      if (/^https?:/.test(url)) { unexpectedRequests.push(new URL(url).hostname); return route.abort(); }
      return route.continue();
    });

    const isWorker = (worker: { url(): string }) => worker.url().endsWith('/background.js');
    const worker = context.serviceWorkers().find(isWorker) ?? await context.waitForEvent('serviceworker', isWorker);
    const settings = await context.newPage();
    await settings.goto(new URL('options.html', worker.url()).href);
    await expect(settings.locator('#save-key')).toBeEnabled();
    await settings.evaluate(async entries => await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('stream-companion');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('mappings', 'readwrite');
        const store = tx.objectStore('mappings');
        for (const { titleId, imdbId, title } of entries) {
          const ref = { platformId: 'netflix', titleId };
          store.put({ key: JSON.stringify(['netflix', titleId]), value: {
            ref, subject: { namespace: 'imdb', id: imdbId }, revision: 1, method: 'manual',
            evidence: { ref, displayTitle: title, mediaType: 'unknown', adapterVersion: 3 },
            details: { title, year: '2020', mediaType: 'movie' }, resolverVersion: 6, rejected: [],
          } });
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), grid);

    const browse = await context.newPage();
    await browse.addInitScript(() => {
      const errors: string[] = [];
      Reflect.set(window, 'fixtureRatingErrors', errors);
      const watch = (host: Element) => {
        const button = host.shadowRoot?.querySelector('button');
        if (!button) return;
        const record = () => {
          const message = button.getAttribute('aria-label') ?? '';
          if (button.textContent === 'IMDb !') errors.push(message);
        };
        record();
        new MutationObserver(record).observe(button, { attributes: true, attributeFilter: ['aria-label'] });
      };
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('[data-sc-root="badge"]')) watch(node);
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await browse.goto(browseUrl);
    const badges = browse.locator('[data-sc-root="badge"] .badge');
    await expect(badges).toHaveCount(grid.length);
    await expect.poll(() => downloads).toBe(1);
    await expect(badges.and(browse.locator('[data-rated="true"]'))).toHaveCount(grid.length, { timeout: 30_000 });
    // Keep transient IPC failures visible to the assertion even if an automatic retry recovers.
    expect(await browse.evaluate(() => Reflect.get(window, 'fixtureRatingErrors'))).toEqual([]);
    expect(downloads).toBe(1);
    expect(unexpectedRequests).toEqual([]);
  } finally {
    await context.close();
    const outputRoot = path.resolve(info.outputDir) + path.sep;
    if (path.resolve(profile).startsWith(outputRoot)) await rm(profile, { recursive: true, force: true });
  }
});
