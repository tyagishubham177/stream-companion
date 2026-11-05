import { rpc } from '../shared/client';
import type { AppStatus, SavedMatch } from '../shared/contracts';
import { action, element, imdbLink, message, notice } from './ui';

let currentStatus: AppStatus | undefined;
const keyInput = element<HTMLInputElement>('api-key');
const enabled = element<HTMLInputElement>('enabled');
const cacheOnly = element<HTMLInputElement>('cache-only');
const corner = element<HTMLSelectElement>('corner');

function renderStatus(status: AppStatus, updatePreferences = false): void {
  currentStatus = status;
  if (updatePreferences) {
    enabled.checked = status.settings.enabled;
    cacheOnly.checked = status.settings.cacheOnly;
    corner.value = status.settings.corner;
  }
  const provider = element('provider-label');
  provider.textContent = status.provider.kind === 'ready' ? 'Configured' : status.provider.kind === 'setup' ? 'Setup needed' : 'Lookups paused';
  provider.dataset.tone = status.provider.kind;
  element('provider-message').textContent = status.provider.message;
  element('key-state').textContent = status.keyConfigured
    ? 'A key is saved in this browser. Enter a new key above to replace it.'
    : 'No key saved. Activate an OMDb key, then save and test it here.';
  element<HTMLButtonElement>('test-key').disabled = !status.keyConfigured;
  element<HTMLButtonElement>('remove-key').disabled = !status.keyConfigured;
  element('usage').textContent = `${status.requests24h} / ${status.totalLimit} local limit`;
  element('rating-count').textContent = String(status.ratings);
}

async function refreshStatus(updatePreferences = false): Promise<void> {
  renderStatus(await rpc<AppStatus>({ type: 'GET_STATUS' }), updatePreferences);
}

async function refreshMatches(): Promise<void> {
  const matches = await rpc<SavedMatch[]>({ type: 'LIST_MATCHES' });
  const list = element<HTMLUListElement>('matches-list');
  list.replaceChildren();
  element('matches-summary').textContent = matches.length
    ? `${matches.length} saved ${matches.length === 1 ? 'match' : 'matches'} in this browser.`
    : 'No saved matches yet. Use “Wrong match?” from a title’s rating details to choose its IMDb identity.';
  for (const match of matches) {
    const item = document.createElement('li');
    const copy = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'match-title';
    title.textContent = match.displayTitle;
    const context = document.createElement('p');
    context.className = 'small muted';
    context.textContent = `${match.ref.platformId === 'netflix' ? 'Netflix' : match.ref.platformId} · ${match.ref.titleId}`;
    copy.append(title, context, imdbLink(match.imdbId));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove saved match for ${match.displayTitle}`);
    remove.addEventListener('click', () => {
      void action(remove, async () => {
        await rpc<unknown>({ type: 'REMOVE_MATCH', ref: match.ref, revision: match.revision });
        await Promise.all([refreshMatches(), refreshStatus()]);
        notice('Saved match removed. An older lookup cannot restore that choice.');
      });
    });
    item.append(copy, remove);
    list.append(item);
  }
  element<HTMLButtonElement>('reset-matches').disabled = matches.length === 0;
}

element<HTMLFormElement>('key-form').addEventListener('submit', event => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) return;
  void action(element<HTMLButtonElement>('save-key'), async () => {
    try {
      await rpc<unknown>({ type: 'SET_API_KEY', key });
      keyInput.value = '';
      notice('Key saved. Testing the connection…');
      await rpc<unknown>({ type: 'TEST_API_KEY' });
      await refreshStatus();
      notice('Connection test passed. Your OMDb key was accepted.');
    } catch (error) {
      keyInput.value = '';
      try { await refreshStatus(); }
      catch { throw new Error(`${message(error)} Connection status could not be refreshed; reload settings.`); }
      throw error;
    }
  });
});

element<HTMLButtonElement>('test-key').addEventListener('click', () => {
  void action(element<HTMLButtonElement>('test-key'), async () => {
    await rpc<unknown>({ type: 'TEST_API_KEY' });
    await refreshStatus();
    notice('Connection test passed. Your OMDb key was accepted.');
  }).finally(() => {
    if (currentStatus) element<HTMLButtonElement>('test-key').disabled = !currentStatus.keyConfigured;
  });
});

element<HTMLButtonElement>('remove-key').addEventListener('click', () => {
  if (!window.confirm('Remove the OMDb key from this browser? Cached ratings and saved matches will remain.')) return;
  void action(element<HTMLButtonElement>('remove-key'), async () => {
    await rpc<unknown>({ type: 'REMOVE_API_KEY' });
    keyInput.value = '';
    await refreshStatus();
    notice('API key removed.');
  }).finally(() => {
    if (currentStatus) element<HTMLButtonElement>('remove-key').disabled = !currentStatus.keyConfigured;
  });
});

element<HTMLFormElement>('preferences-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(element<HTMLButtonElement>('save-preferences'), async () => {
    await rpc<unknown>({
      type: 'UPDATE_SETTINGS',
      settings: { enabled: enabled.checked, cacheOnly: cacheOnly.checked, corner: corner.value === 'top-left' ? 'top-left' : 'top-right' },
    });
    await refreshStatus(true);
    notice('Browsing preferences saved.');
  });
});

element<HTMLButtonElement>('reset-matches').addEventListener('click', () => {
  if (!window.confirm('Reset all saved title matches? Cached ratings, your key and request accounting will remain.')) return;
  void action(element<HTMLButtonElement>('reset-matches'), async () => {
    await rpc<unknown>({ type: 'RESET_MATCHES' });
    await Promise.all([refreshMatches(), refreshStatus()]);
    notice('Saved matches reset.');
  }).finally(() => {
    element<HTMLButtonElement>('reset-matches').disabled = element('matches-list').childElementCount === 0;
  });
});

element<HTMLButtonElement>('clear-cache').addEventListener('click', () => {
  if (!window.confirm('Clear cached ratings? Saved matches, your key, request accounting and cooldowns will be preserved.')) return;
  void action(element<HTMLButtonElement>('clear-cache'), async () => {
    await rpc<unknown>({ type: 'CLEAR_RATING_CACHE' });
    await refreshStatus();
    notice('Ratings cache cleared.');
  });
});

element<HTMLButtonElement>('diagnostics').addEventListener('click', () => {
  void action(element<HTMLButtonElement>('diagnostics'), async () => {
    const diagnostics = await rpc<unknown>({ type: 'EXPORT_DIAGNOSTICS' });
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `stream-companion-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('Redacted diagnostics downloaded.');
  });
});

void (async () => {
  try {
    await Promise.all([refreshStatus(true), refreshMatches()]);
    for (const id of ['save-key', 'save-preferences', 'clear-cache', 'diagnostics']) element<HTMLButtonElement>(id).disabled = false;
    notice('');
  } catch (error) { notice(message(error), true); }
})();
