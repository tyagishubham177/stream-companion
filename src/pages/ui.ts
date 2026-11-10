import { platformLabel, platformTitleUrl } from '../platforms/links';
import { rpc } from '../shared/client';
import type { Settings, TitleObservation } from '../shared/contracts';

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}

export function notice(message: string, error = false): void {
  const node = element('notice');
  node.textContent = message;
  node.dataset.tone = error ? 'error' : 'normal';
  node.setAttribute('role', error ? 'alert' : 'status');
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export async function action(button: HTMLButtonElement, task: () => Promise<void>): Promise<void> {
  if (button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try { await task(); }
  catch (error) { notice(message(error), true); }
  finally { button.disabled = false; button.textContent = label; }
}

export function imdbLink(id: string, label = 'Open IMDb'): HTMLAnchorElement {
  const link = document.createElement('a');
  link.textContent = label;
  if (/^tt\d{7,12}$/.test(id)) {
    link.href = `https://www.imdb.com/title/${id}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  return link;
}

export function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}
export function bindPrimaryFeatures(onSaved?: () => void): (settings: Settings) => void {
  const features = [
    { key: 'ratingsEnabled', label: 'IMDb ratings' },
    { key: 'marksEnabled', label: 'Mark as watched' },
  ] as const;
  const controls = features.map(feature => ({ ...feature, input: element<HTMLInputElement>(feature.key) }));
  let saving = false;
  for (const { key, label, input } of controls) {
    input.addEventListener('change', () => {
      if (saving) return;
      saving = true;
      const checked = input.checked;
      for (const control of controls) control.input.disabled = true;
      void rpc({ type: 'UPDATE_SETTINGS', settings: { [key]: checked } })
        .then(() => { notice(`${label} ${checked ? 'enabled' : 'disabled'}.`); onSaved?.(); })
        .catch(error => { input.checked = !checked; notice(message(error), true); })
        .finally(() => {
          saving = false;
          for (const control of controls) control.input.disabled = false;
        });
    });
  }
  return settings => {
    if (saving) return;
    for (const { key, input } of controls) {
      input.checked = settings[key] !== false;
      input.disabled = false;
    }
  };
}

export function streamingLink(observation: Pick<TitleObservation, 'ref' | 'pagePath'>): HTMLAnchorElement | null {
  const url = platformTitleUrl(observation);
  if (!url) return null;
  const link = document.createElement('a');
  link.href = url;
  link.textContent = `Open on ${platformLabel(observation.ref.platformId)} ↗`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
