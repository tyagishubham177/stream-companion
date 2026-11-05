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
