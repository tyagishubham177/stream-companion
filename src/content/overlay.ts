import type { LookupState, TitleObservation } from '../shared/contracts';
import { badgeText, stateDescription } from '../features/ratings/presentation';
import { DAY_MS, ratingFreshFor } from '../shared/freshness';
import { badgeStyles, overlayStyles } from './styles';

export interface BadgeMount {
  host: HTMLDivElement;
  container: HTMLElement;
  button: HTMLButtonElement;
  dispose(): void;
}

export interface DetailsModel {
  observation: TitleObservation;
  state: LookupState | null;
  button: HTMLButtonElement;
  fallbackFocus(): HTMLElement | null;
  refresh(): Promise<void>;
  correct(): Promise<void>;
  settings(): Promise<void>;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export class Overlay {
  readonly host = document.createElement('div');
  readonly root: ShadowRoot;
  private panel: HTMLDivElement | null = null;
  private model: DetailsModel | null = null;
  private readonly onOutside = (event: PointerEvent): void => {
    if (!this.model || !this.panel) return;
    const path = event.composedPath();
    if (!path.includes(this.panel) && !path.includes(this.model.button)) this.close(false);
  };
  private readonly onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.panel) {
      event.preventDefault(); event.stopPropagation(); this.close();
    }
  };

  constructor() {
    this.host.dataset.scRoot = 'ratings';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = element('style'); style.textContent = overlayStyles;
    this.root.append(style);
    // Extension controls are siblings of site content, never descendants of playback links.
    for (const name of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) {
      this.root.addEventListener(name, event => event.stopPropagation());
    }
    document.documentElement.append(this.host);
    document.addEventListener('pointerdown', this.onOutside, true);
    document.addEventListener('keydown', this.onEscape, true);
  }

  createBadge(container: HTMLElement, title: string, open: (button: HTMLButtonElement) => void): BadgeMount {
    const host = element('div'); host.dataset.scRoot = 'badge';
    host.dataset.scRenderer = 'native-0.3.0';
    const root = host.attachShadow({ mode: 'open' });
    const style = element('style'); style.textContent = badgeStyles; root.append(style);
    const previous = container.style.getPropertyValue('position');
    const priority = container.style.getPropertyPriority('position');
    const positioned = getComputedStyle(container).position === 'static';
    if (positioned) container.style.setProperty('position', 'relative');
    const button = element('button', 'IMDb …', 'badge');
    button.type = 'button'; button.hidden = true;
    button.setAttribute('aria-label', `${title}: looking up IMDb rating`);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation(); open(button);
    });
    for (const name of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup']) {
      root.addEventListener(name, event => event.stopPropagation());
    }
    root.append(button); container.append(host);
    return { host, container, button, dispose() {
      host.remove();
      // Preserve site changes made after the mount took ownership.
      if (positioned && container.style.getPropertyValue('position') === 'relative' && !container.style.getPropertyPriority('position')) {
        if (previous) container.style.setProperty('position', previous, priority);
        else container.style.removeProperty('position');
      }
    } };
  }

  updateBadge(button: HTMLButtonElement, observation: TitleObservation, state: LookupState | null): void {
    button.textContent = badgeText(state);
    button.dataset.rated = String(state?.kind === 'rated');
    const rating = state?.kind === 'rated' ? ` ${state.record.score?.toFixed(1)} out of 10.` : '';
    button.setAttribute('aria-label', `${observation.displayTitle}: ${stateDescription(state)}.${rating} Open details`);
    button.title = `${observation.displayTitle} · ${stateDescription(state)}`;
    if (this.model?.button === button) {
      const model = { ...this.model, observation, state };
      const focused = this.root.activeElement;
      const focusLabel = focused?.getAttribute('aria-label') ?? focused?.textContent;
      const hadPanelFocus = !!this.panel && this.panel.contains(focused);
      this.panel?.remove(); this.panel = null; this.model = null;
      this.show(model, hadPanelFocus);
      if (hadPanelFocus && focusLabel) {
        const replacement = Array.from(this.root.querySelectorAll<HTMLElement>('.panel button,.panel a'))
          .find(control => (control.getAttribute('aria-label') ?? control.textContent) === focusLabel);
        replacement?.focus({ preventScroll: true });
      }
    }
  }

  show(model: DetailsModel, focus = true): void {
    if (this.model?.button === model.button) { this.close(); return; }
    this.close(false);
    this.model = model;
    model.button.setAttribute('aria-expanded', 'true');
    const panel = element('div', undefined, 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'sc-title');
    const close = element('button', '×', 'close'); close.type = 'button';
    close.setAttribute('aria-label', 'Close rating details');
    close.addEventListener('click', () => this.close());
    panel.append(element('p', 'Stream Companion / Ratings', 'eyebrow'), close);
    const state = model.state;
    const record = state?.kind === 'rated' || state?.kind === 'unrated' ? state.record : null;
    const heading = element('h2', record?.title ?? model.observation.displayTitle); heading.id = 'sc-title';
    panel.append(heading);
    if (record) {
      panel.append(element('p', `${record.year} · ${record.mediaType === 'series' ? 'Series' : 'Movie'}`, 'meta'));
      const score = element('div', record.score === null ? 'NR' : record.score.toFixed(1), 'score');
      if (record.score !== null) score.append(element('small', ' / 10'));
      panel.append(score);
      if (record.votes !== null) panel.append(element('p', `${record.votes.toLocaleString()} IMDb votes`, 'meta'));
      panel.append(element('p', 'IMDb rating via OMDb', 'meta'));
      if (state && (state.kind === 'rated' || state.kind === 'unrated') && state.identitySource === 'wikidata')
        panel.append(element('p', 'Matched automatically by streaming title ID via Wikidata', 'meta'));
      if (state && (state.kind === 'rated' || state.kind === 'unrated') && state.identitySource === 'netflix')
        panel.append(element('p', 'Matched automatically using Netflix’s public film title, release year and type', 'meta'));
      panel.append(element('p', `Last fetched ${new Date(record.fetchedAt).toLocaleString()}`, 'meta'));
      panel.append(element('p', `Automatic refresh after ${ratingFreshFor(record) / DAY_MS} days when visible`, 'meta'));
    }
    panel.append(element('p', stateDescription(state)));
    if (state?.kind === 'needs_match') panel.append(element('p', 'Automatic lookup could not identify a single title. You can choose a match if you want; browsing does not require it.'));
    if (state?.kind === 'deferred' && state.retryAfter) {
      panel.append(element('p', `Eligible to retry after ${new Date(state.retryAfter).toLocaleString()}`, 'meta'));
    }
    const actions = element('div', undefined, 'actions');
    const feedback = element('p', undefined, 'feedback'); feedback.setAttribute('role', 'status');
    const act = (label: string, task: () => Promise<void>, primary = false): void => {
      const button = element('button', label, primary ? 'primary' : undefined); button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true; feedback.textContent = '';
        try { await task(); }
        catch (error) { feedback.textContent = error instanceof Error ? error.message : 'This action could not finish. Try again.'; }
        finally { button.disabled = false; }
      });
      actions.append(button);
    };
    if (state?.kind === 'setup_required') act('Open settings', model.settings, true);
    else if (state) {
      act(record ? 'Wrong match?' : 'Find a match', model.correct, !record);
      if (record) {
        const imdb = element('a', 'Open IMDb');
        imdb.href = `https://www.imdb.com/title/${record.subject.id}/`;
        imdb.target = '_blank'; imdb.rel = 'noopener noreferrer';
        actions.append(imdb);
        act('Refresh', model.refresh);
      }
    }
    panel.append(actions, feedback);
    this.root.append(panel); this.panel = panel;
    this.positionPanel(); if (focus) close.focus({ preventScroll: true });
  }

  positionPanel(): void {
    if (!this.panel || !this.model) return;
    if (this.model.button.hidden || !this.model.button.isConnected) { this.close(false); return; }
    const rect = this.model.button.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    const x = Math.min(Math.max(12, rect.right - panelRect.width), Math.max(12, innerWidth - panelRect.width - 12));
    let y = rect.bottom + 8;
    if (y + panelRect.height > innerHeight - 12) y = Math.max(12, rect.top - panelRect.height - 8);
    this.panel.style.left = `${x}px`; this.panel.style.top = `${y}px`;
  }

  closeFor(button: HTMLButtonElement): void { if (this.model?.button === button) this.close(false); }
  close(restoreFocus = true): void {
    const button = this.model?.button;
    const ownedFocus = !!this.panel && this.panel.contains(this.root.activeElement);
    const fallback = this.model?.fallbackFocus();
    this.panel?.remove(); this.panel = null; this.model = null;
    button?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && button?.isConnected && !button.hidden) button.focus({ preventScroll: true });
    else if (restoreFocus && ownedFocus && fallback?.isConnected) fallback.focus({ preventScroll: true });
  }
  dispose(): void {
    this.close(false);
    document.removeEventListener('pointerdown', this.onOutside, true);
    document.removeEventListener('keydown', this.onEscape, true);
    this.host.remove();
  }
}
