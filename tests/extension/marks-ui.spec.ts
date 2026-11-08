import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { DEFAULT_SETTINGS } from '../../src/shared/contracts';
import type { TitleMark } from '../../src/shared/marks';

let browser: Browser;
let script: string;
test.beforeAll(async () => {
  script = (await build({ entryPoints: ['src/features/marks/controller.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'MarksUIFixture', target: 'chrome120' })).outputFiles[0].text;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => { await browser?.close(); });
async function fixture(holdFirstRead = false): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith('https://www.netflix.com/') ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>
    body{background:#151515;color:white;font:16px Arial;margin:40px}.row{display:flex;gap:20px}.tile{width:280px;height:165px}.tile>a{display:block;position:relative;width:280px;height:165px;border-radius:8px}.tile img{display:block;width:280px;height:165px;filter:contrast(1.1)}.progress{position:absolute;bottom:0;left:0;width:50%;height:4px;background:red;z-index:4}
    </style><h1>Marks fixture</h1><div class="row">${[0, 1].map(i => `<div class="tile" id="tile-${i}"><a data-uia="standard-card" aria-label="Fixture Film" href="/search?jbv=1001"><img alt="Fixture Film" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='280' height='165'%3E%3Crect width='140' height='165' fill='red'/%3E%3Crect x='140' width='140' height='165' fill='green'/%3E%3C/svg%3E"><span class="progress"></span></a></div>`).join('')}</div>` }) : route.abort());
  await page.addInitScript(({ settings, holdFirstRead }) => {
    const listeners: Array<(message: unknown) => void> = [];
    let mark: TitleMark | undefined;
    let previous: TitleMark | undefined;
    const preferences = { ...settings, ratingsEnabled: false };
    let firstRead = true;
    let releaseHeld: (() => void) | undefined;
    const broadcast = (message: unknown) => listeners.forEach(listener => listener(message));
    const fixture = {
      settings(patch: object) { Object.assign(preferences, patch); broadcast({ type: 'SC_INVALIDATE' }); },
      remote() { if (mark) { mark = { ...mark, revision: mark.revision + 1, plan: 'want', operationId: crypto.randomUUID() }; broadcast({ type: 'SC_MARKS_CHANGED', ref: mark.observation.ref }); } },
      publishAndRelease() {
        mark = { observation: { ref: { platformId: 'netflix', titleId: '1001' }, displayTitle: 'Fixture Film', mediaType: 'movie', adapterVersion: 3 },
          watched: true, plan: 'want', changedAt: Date.now(), revision: 1, operationId: crypto.randomUUID() };
        broadcast({ type: 'SC_MARKS_CHANGED', ref: mark.observation.ref }); releaseHeld?.();
      },
    };
    Object.assign(window, { fixture, playbackCount: 0 });
    document.addEventListener('click', event => { if ((event.target as Element).closest('a')) { event.preventDefault(); (window as unknown as { playbackCount: number }).playbackCount++; } }, true);
    const runtime = { id: 'synthetic-fixture', onMessage: { addListener(listener: (message: unknown) => void) { listeners.push(listener); }, removeListener() {} },
      async sendMessage(request: Record<string, unknown>) {
        const okay = (value: unknown) => ({ ok: true, value });
        if (request.type === 'GET_PUBLIC_STATUS') return okay({ settings: preferences, keyConfigured: false, provider: { kind: 'setup', message: 'No key' } });
        if (request.type === 'GET_MARKS') {
          const snapshot = { marks: mark ? [mark] : [], epoch: 0 };
          if (firstRead && holdFirstRead) { firstRead = false; await new Promise<void>(resolve => { releaseHeld = resolve; }); }
          return okay(snapshot);
        }
        if (request.type === 'SET_MARK') {
          if (request.revision !== (mark?.revision ?? 0)) return { ok: false, error: 'This title changed elsewhere. Open its marks to edit.' };
          previous = mark;
          mark = { observation: request.observation as TitleMark['observation'], watched: typeof request.watched === 'boolean' ? request.watched : mark?.watched ?? false,
            plan: (request.plan ?? mark?.plan ?? 'none') as TitleMark['plan'], revision: (mark?.revision ?? 0) + 1, operationId: crypto.randomUUID(), changedAt: Date.now() };
          broadcast({ type: 'SC_MARKS_CHANGED', ref: mark.observation.ref }); return okay({ mark, epoch: 0 });
        }
        if (request.type === 'UNDO_MARK') {
          if (!mark || request.revision !== mark.revision || request.operationId !== mark.operationId) return { ok: false, error: 'This title changed elsewhere. Open its marks to edit.' };
          mark = { ...mark, watched: previous?.watched ?? false, plan: previous?.plan ?? 'none', revision: mark.revision + 1, operationId: crypto.randomUUID() };
          broadcast({ type: 'SC_MARKS_CHANGED', ref: mark.observation.ref }); return okay({ mark, epoch: 0 });
        }
        return { ok: false, error: 'Unsupported synthetic request' };
      } };
    Object.defineProperty(window, 'chrome', { value: { runtime }, configurable: true });
  }, { settings: DEFAULT_SETTINGS, holdFirstRead });
  await page.goto('https://www.netflix.com/search?q=film'); await page.addScriptTag({ content: script });
  await page.evaluate(() => new (window as unknown as { MarksUIFixture: { MarksController: new () => { start(): void } } }).MarksUIFixture.MarksController().start());
  await expect(page.locator('[data-sc-root="marks"] button')).toHaveCount(2);
  if (!holdFirstRead) await expect(page.locator('[data-sc-root="marks"] button').first()).toBeEnabled();
  return page;
}
async function choose(page: Page, label: string): Promise<void> {
  const button = page.locator('[data-sc-root="marks"] button').first(); await button.focus(); await button.press('Enter');
  await page.getByRole(label === 'Watched' ? 'menuitemcheckbox' : 'menuitemradio', { name: label, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

test('marks work without ratings/key; watched keeps colour, rewatch retains both facts, pass affects artwork only', async () => {
  const page = await fixture();
  await choose(page, 'Watched');
  await expect(page.locator('[data-sc-root="mark-effect"][data-effect="watched"]')).toHaveCount(2);
  expect(await page.locator('img').first().evaluate(image => image.style.filter)).toBe('');
  expect(await page.locator('[data-sc-root="mark-effect"]').first().evaluate(effect => getComputedStyle(effect).backdropFilter)).toBe('none');
  await choose(page, 'Want to watch');
  await expect(page.locator('[data-sc-root="marks"] button').first()).toHaveAttribute('aria-label', /Watched.*Want to watch/);
  await choose(page, 'Won’t watch');
  await expect(page.locator('[data-sc-root="mark-effect"][data-effect="pass"]')).toHaveCount(2);
  const result = await page.locator('[data-sc-root="mark-effect"]').first().evaluate(effect => ({ filter: getComputedStyle(effect).backdropFilter,
    next: effect.nextElementSibling?.className, background: getComputedStyle(effect).backgroundColor, pointer: getComputedStyle(effect).pointerEvents }));
  expect(result).toMatchObject({ filter: 'grayscale(1)', next: 'progress', pointer: 'none' });
  expect(await page.evaluate(() => (window as unknown as { playbackCount: number }).playbackCount)).toBe(0);
  await page.close();
});
test('visual and module toggles clean up owned layers while preserving site styles', async () => {
  const page = await fixture(); await choose(page, 'Watched');
  await page.evaluate(() => (window as unknown as { fixture: { settings(patch: object): void } }).fixture.settings({ shadeWatched: false }));
  await expect(page.locator('[data-sc-root="mark-effect"]')).toHaveCount(0);
  await expect(page.locator('[data-sc-root="marks"]')).toHaveCount(2);
  await page.locator('#tile-0').evaluate(node => (node as HTMLElement).style.position = 'absolute');
  await page.evaluate(() => (window as unknown as { fixture: { settings(patch: object): void } }).fixture.settings({ marksEnabled: false }));
  await expect(page.locator('[data-sc-root="marks"]')).toHaveCount(0);
  expect(await page.locator('#tile-0').evaluate(node => (node as HTMLElement).style.position)).toBe('absolute');
  expect(await page.locator('img').first().evaluate(image => getComputedStyle(image).filter)).toBe('contrast(1.1)');
  await page.close();
});
test('Undo cannot replace a newer decision and an open menu never retargets a recycled tile', async () => {
  const page = await fixture(); await choose(page, 'Watched');
  await page.evaluate(() => (window as unknown as { fixture: { remote(): void } }).fixture.remote());
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('changed elsewhere');
  const button = page.locator('[data-sc-root="marks"] button').first(); await button.focus(); await button.press('Enter');
  await page.locator('#tile-0>a').evaluate(anchor => { anchor.setAttribute('href', '/search?jbv=1002'); anchor.setAttribute('aria-label', 'Another Film'); });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator('#tile-0 [data-sc-root="marks"] button')).toHaveAttribute('aria-label', /Another Film/);
  await expect(page.locator('#tile-0 [data-sc-root="mark-effect"]')).toHaveCount(0);
  await page.close();
});
test('a change broadcast invalidates an older in-flight snapshot before it can hide the newer mark', async () => {
  const page = await fixture(true);
  await expect(page.locator('[data-sc-root="marks"] button').first()).toBeDisabled();
  await page.evaluate(() => (window as unknown as { fixture: { publishAndRelease(): void } }).fixture.publishAndRelease());
  await expect(page.locator('[data-sc-root="marks"] button').first()).toHaveAttribute('aria-label', /Watched.*Want to watch/);
  await expect(page.locator('[data-sc-root="mark-effect"][data-effect="watched"]')).toHaveCount(2);
  await page.close();
});
