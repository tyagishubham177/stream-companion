import { platformLabel } from '../platforms/links';
import { rpc } from '../shared/client';
import type { AppStatus, PageStats } from '../shared/contracts';
import { bindPrimaryFeatures, element, message, notice } from './ui';

const renderPrimaryFeatures = bindPrimaryFeatures(() => { void readPage(); });

function renderStatus(status: AppStatus): void {
  renderPrimaryFeatures(status.settings);
  element('features-paused').hidden = status.settings.enabled;
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
    if (!stats || typeof stats.supported !== 'boolean' || !['netflix', 'hotstar'].includes(stats.platformId)) throw new Error('No page connection.');
    const platform = platformLabel(stats.platformId);
    label.textContent = stats.supported ? platform : 'Unsupported surface';
    detail.textContent = stats.supported
      ? `${stats.tiles} supported ${stats.tiles === 1 ? 'tile' : 'tiles'} detected on this page.`
      : `Open a supported ${platform} browsing page, search or title page.`;
    element('page-stats').hidden = !stats.supported;
    if (stats.supported) {
      for (const field of ['rated', 'cached', 'unresolved'] as const) {
        element(field).textContent = Number.isFinite(stats[field]) ? String(stats[field]) : '—';
      }
    }
  } catch {
    label.textContent = 'No connection';
    detail.textContent = 'Open Netflix or JioHotstar. After installing or updating, refresh that tab to connect.';
    element('page-stats').hidden = true;
  }
}

element('settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage().catch(error => notice(message(error), true));
});

void rpc<AppStatus>({ type: 'GET_STATUS' }).then(renderStatus).catch(error => notice(message(error), true));
void readPage();
