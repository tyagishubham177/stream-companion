import { rpc } from '../shared/client';
import type { AppStatus, PageStats } from '../shared/contracts';
import { element, message, notice } from './ui';

const enabled = element<HTMLInputElement>('enabled');

function renderStatus(status: AppStatus): void {
  enabled.checked = status.settings.enabled;
  enabled.disabled = false;
  element('provider').textContent = status.provider.message;
  element('usage').textContent = `${status.requests24h} requests recorded in the last 24 hours · ${status.totalLimit} local limit`;
  element('cache-mode').hidden = !status.settings.cacheOnly;
}

async function readPage(): Promise<void> {
  const label = element('page-status');
  const detail = element('page-message');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab.');
    const stats: PageStats | undefined = await chrome.tabs.sendMessage(tab.id, { type: 'SC_GET_PAGE_STATS' });
    if (!stats || typeof stats.supported !== 'boolean' || stats.platformId !== 'netflix') throw new Error('No page connection.');
    label.textContent = stats.supported ? 'Netflix' : 'Unsupported surface';
    detail.textContent = stats.supported
      ? `${stats.tiles} supported ${stats.tiles === 1 ? 'tile' : 'tiles'} detected on this page.`
      : 'This Netflix surface is outside v1 support. Open a browse, search or My List page.';
    if (stats.supported) {
      for (const field of ['rated', 'cached', 'unresolved'] as const) {
        element(field).textContent = Number.isFinite(stats[field]) ? String(stats[field]) : '—';
      }
      element('page-stats').hidden = false;
    }
  } catch {
    label.textContent = 'No connection';
    detail.textContent = 'Open a Netflix browse page. After installing or updating, refresh that tab to connect.';
    element('page-stats').hidden = true;
  }
}

enabled.addEventListener('change', () => {
  const next = enabled.checked;
  enabled.disabled = true;
  void rpc<unknown>({ type: 'UPDATE_SETTINGS', settings: { enabled: next } })
    .then(async () => {
      renderStatus(await rpc<AppStatus>({ type: 'GET_STATUS' }));
      notice(next ? 'Stream Companion enabled.' : 'Stream Companion disabled.');
      await readPage();
    })
    .catch(error => { enabled.checked = !next; notice(message(error), true); })
    .finally(() => { enabled.disabled = false; });
});
element('settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage().catch(error => notice(message(error), true));
});

void rpc<AppStatus>({ type: 'GET_STATUS' }).then(renderStatus).catch(error => notice(message(error), true));
void readPage();
