import { titleKey, type PlatformTitleRef, type TitleObservation } from '../../shared/contracts';
import { hasMarks, markLabel, type MarkPatch, type TitleMark } from '../../shared/marks';
import { acquirePositioning } from '../../content/positioning';
import { claimPanel, releasePanel } from '../../content/panel-coordinator';
import { markIcon } from './icons';
import { buttonStyles, panelStyles } from './styles';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
/** Keep a pressed control targeted through layout movement, preserving drag cancellation. */
function preservePointerClick(button: HTMLButtonElement): void {
  let press: { pointerId: number; x: number; y: number; cancelled: boolean } | undefined;
  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, cancelled: false };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener('pointermove', event => {
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.cancelled = true;
  });
  button.addEventListener('pointercancel', event => { if (press?.pointerId === event.pointerId) press.cancelled = true; });
  button.addEventListener('click', event => {
    const cancelled = event.detail > 0 && press?.cancelled;
    press = undefined;
    if (cancelled) { event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation(); }
  }, true);
}
const EXPANDED = '[data-uia="modal-motion-container-MINI_MODAL"],[data-uia="modal-motion-container-DETAIL_MODAL"]';
export interface MarkMount {
  host: HTMLDivElement; button: HTMLButtonElement; container: HTMLElement;
  update(mark: TitleMark | undefined, observation: TitleObservation, ratings: boolean, corner: 'top-left' | 'top-right'): void;
  effect(artwork: HTMLElement | null, mode: 'watched' | 'pass' | null): void;
  invalidateLayout(): void;
  dispose(): void;
}

/** Card-relative control and a separately owned, passive artwork effect. */
export function mountMark(container: HTMLElement, open: (button: HTMLButtonElement) => void): MarkMount {
  const releasePosition = acquirePositioning(container);
  const host = element('div'); host.dataset.scRoot = 'marks';
  const root = host.attachShadow({ mode: 'open' });
  const style = element('style'); style.textContent = buttonStyles;
  const button = element('button', 'Mark'); button.type = 'button';
  preservePointerClick(button);
  button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
  root.append(style, button); container.append(host);
  const reveal = () => { host.dataset.reveal = 'true'; };
  const conceal = () => { if (root.activeElement !== button && button.getAttribute('aria-expanded') !== 'true') host.dataset.reveal = 'false'; };
  container.addEventListener('mouseenter', reveal); container.addEventListener('mouseleave', conceal);
  container.addEventListener('focusin', reveal); container.addEventListener('focusout', conceal);
  button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(button); });
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup']) root.addEventListener(type, event => event.stopPropagation());
  let effect: HTMLDivElement | undefined;
  let artworkNode: HTMLElement | null = null;
  let releaseArtwork: (() => void) | undefined;
  let accentOwned = false;
  let effectMode: 'watched' | 'pass' | null = null;
  let renderKey = '';
  let previousAccent = '', previousPriority = '';
  const restoreAccent = () => {
    if (accentOwned && container.style.getPropertyValue('--sc-rating-accent') === '#fff') {
      if (previousAccent) container.style.setProperty('--sc-rating-accent', previousAccent, previousPriority);
      else container.style.removeProperty('--sc-rating-accent');
    }
    accentOwned = false;
  };
  const removeEffect = () => { effect?.remove(); effect = undefined; artworkNode = null; effectMode = null; releaseArtwork?.(); releaseArtwork = undefined; restoreAccent(); };
  return {
    host, button, container,
    update(mark, observation, ratings, corner) {
      const expanded = !!container.closest(EXPANDED);
      const nextKey = JSON.stringify([mark?.revision, mark?.watched, mark?.plan, observation.displayTitle, ratings, corner, expanded]);
      if (nextKey === renderKey) return;
      renderKey = nextKey;
      host.dataset.active = String(!!mark && hasMarks(mark)); host.dataset.corner = corner;
      // Netflix can mount a preview beneath a stationary pointer. There may be
      // no subsequent mouseenter, so expanded controls are explicitly visible.
      host.dataset.expanded = String(expanded);
      button.replaceChildren();
      if (mark?.plan === 'pass') button.append(markIcon('pass'));
      else if (mark?.plan === 'want') button.append(markIcon('want'));
      else if (mark?.watched) button.append(markIcon('watched'));
      else button.textContent = 'Mark';
      const description = mark ? markLabel(mark) : 'No marks';
      button.title = `${description}. Edit your marks`;
      button.setAttribute('aria-label', `${observation.displayTitle}: ${description}. Edit your marks`);
      // Reserve a fixed score slot; a score arriving must not move the Mark
      // target. No scroll-time card or badge measurements are needed.
      const width = ratings ? 96 : 0;
      button.style.left = corner === 'top-left' ? `${width ? width + 14 : 8}px` : 'auto';
      button.style.right = corner === 'top-right' ? `${width ? width + 14 : 8}px` : 'auto';
    },
    effect(artwork, mode) {
      if (!mode || !artwork || matchMedia('(forced-colors: active)').matches) { removeEffect(); return; }
      // An image/picture needs a tightly bounded parent. The effect sits directly
      // after its artwork, before native overlay labels; it never contains controls.
      const target = artwork.tagName === 'IMG' && artwork.parentElement?.tagName === 'PICTURE' ? artwork.parentElement : artwork;
      if (effectMode === mode && artworkNode === target && effect?.isConnected) return;
      const parent = target.parentElement;
      const box = target.getBoundingClientRect(), parentBox = parent?.getBoundingClientRect();
      if (!parent || !parentBox || !container.contains(target) || box.width < 60 || box.height < 30 ||
        Math.abs(box.left - parentBox.left) > 2 || Math.abs(box.top - parentBox.top) > 2 ||
        Math.abs(box.width - parentBox.width) > 2 || Math.abs(box.height - parentBox.height) > 2) { removeEffect(); return; }
      if (artworkNode !== target || !effect?.isConnected) {
        removeEffect(); artworkNode = target;
        releaseArtwork = acquirePositioning(parent);
        effect = element('div'); effect.dataset.scRoot = 'mark-effect'; effect.setAttribute('aria-hidden', 'true');
        effect.style.cssText = 'position:absolute;inset:0;pointer-events:none;border-radius:inherit;';
        target.insertAdjacentElement('afterend', effect);
      }
      effect!.dataset.effect = mode;
      effectMode = mode;
      effect!.style.background = mode === 'watched' ? 'rgba(0,0,0,.14)' : 'transparent';
      effect!.style.backdropFilter = mode === 'pass' ? 'grayscale(1)' : 'none';
      if (mode === 'pass' && !accentOwned) {
        previousAccent = container.style.getPropertyValue('--sc-rating-accent'); previousPriority = container.style.getPropertyPriority('--sc-rating-accent');
        container.style.setProperty('--sc-rating-accent', '#fff'); accentOwned = true;
      } else if (mode !== 'pass') restoreAccent();
    },
    invalidateLayout() { effectMode = null; },
    dispose() {
      removeEffect(); host.remove(); releasePosition();
      container.removeEventListener('mouseenter', reveal); container.removeEventListener('mouseleave', conceal);
      container.removeEventListener('focusin', reveal); container.removeEventListener('focusout', conceal);
    },
  };
}

interface MenuModel {
  observation: TitleObservation; mark?: TitleMark; anchor: HTMLButtonElement;
  container: HTMLElement;
  current(): boolean; save(patch: MarkPatch): Promise<void>;
}
export class MarksView {
  readonly host = element('div');
  readonly root: ShadowRoot;
  private menu?: HTMLDivElement;
  private menuHost?: HTMLDivElement;
  private model?: MenuModel;
  private toast?: HTMLDivElement;
  private timer?: ReturnType<typeof setTimeout>;
  private expiresAt = 0;
  private readonly outside = (event: PointerEvent) => {
    if (this.menu && !event.composedPath().includes(this.menu) && !event.composedPath().includes(this.model!.anchor)) this.close(false);
  };
  private readonly key = (event: KeyboardEvent) => { if (event.key === 'Escape' && this.menu) { event.preventDefault(); event.stopPropagation(); this.close(true); } };
  constructor() {
    this.host.dataset.scRoot = 'mark-panel'; this.root = this.host.attachShadow({ mode: 'open' });
    const style = element('style'); style.textContent = panelStyles; this.root.append(style); document.documentElement.append(this.host);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup']) this.root.addEventListener(type, event => event.stopPropagation());
    document.addEventListener('pointerdown', this.outside, true); document.addEventListener('keydown', this.key, true);
  }
  ownsEvent(event: Event): boolean { const path = event.composedPath(); return path.includes(this.host) || !!this.menuHost && path.includes(this.menuHost); }
  handleScroll(event: Event): void {
    // Local menus already travel with Netflix's preview. Native focus or
    // scrollIntoView can scroll an ancestor between pointerdown and pointerup;
    // removing the menu then exposes the streaming controls under that click.
    if (!this.ownsEvent(event) && this.menuHost?.dataset.local !== 'true') this.close(false);
  }
  owns(button: HTMLButtonElement): boolean { return this.model?.anchor === button; }
  changed(ref?: PlatformTitleRef): void { if (!ref || this.model && titleKey(this.model.observation.ref) === titleKey(ref)) this.close(false); }
  validate(): void { if (this.model && !this.model.current()) this.close(false); }
  open(model: MenuModel): void {
    this.close(false); claimPanel(this, () => this.close(false)); this.model = model;
    const owner = model.container.closest<HTMLElement>(EXPANDED);
    const menuHost = element('div'); this.menuHost = menuHost; menuHost.dataset.scRoot = 'mark-menu';
    menuHost.dataset.local = String(!!owner);
    const menuRoot = menuHost.attachShadow({ mode: 'open' });
    const menuStyle = element('style'); menuStyle.textContent = panelStyles; menuRoot.append(menuStyle);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup']) menuRoot.addEventListener(type, event => event.stopPropagation());
    // A native hover preview owns mouseleave. Keep our menu in that owner's
    // DOM ancestry so moving into its shadow content does not dismiss Netflix.
    (owner ?? document.documentElement).append(menuHost);
    const menu = element('div', undefined, 'menu'); this.menu = menu;
    const heading = element('h2', model.observation.displayTitle); heading.id = 'marks-title';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-labelledby', heading.id);
    const close = element('button', '×', 'close'); close.type = 'button'; close.setAttribute('aria-label', 'Close your marks'); preservePointerClick(close); close.addEventListener('click', () => this.close(true));
    const mark = model.mark;
    const option = (text: string, icon: 'watched' | 'want' | 'pass' | undefined, checked: boolean, patch: MarkPatch, minor = false) => {
      const button = element('button', undefined, `choice${minor ? ' minor' : ''}`); button.type = 'button';
      button.setAttribute('role', icon === 'watched' ? 'menuitemcheckbox' : icon ? 'menuitemradio' : 'menuitem');
      if (icon) button.setAttribute('aria-checked', String(checked));
      if (icon) button.append(markIcon(icon)); button.append(element('span', text));
      if (checked) button.append(element('span', '✓', 'selected'));
      preservePointerClick(button);
      button.addEventListener('click', async () => {
        if (!model.current()) { this.close(false); return; }
        for (const control of menu.querySelectorAll<HTMLButtonElement>('button')) control.disabled = true;
        try {
          await model.save(patch);
          // The worker's broadcast may already have closed this menu. Do not
          // close a different menu opened while its save was finishing.
          if (this.model && this.model !== model) return;
          this.close(false);
          if (model.current() && model.anchor.isConnected && !model.anchor.hidden) model.anchor.focus({ preventScroll: true });
        }
        catch (error) {
          if (!model.current()) { this.close(false); return; }
          if (this.model !== model) { this.notify(error instanceof Error ? error.message : 'Could not save your mark. Open its marks and try again.'); return; }
          menu.querySelector('.feedback')?.remove();
          const feedback = element('p', error instanceof Error ? error.message : 'Could not save your mark. Try again.', 'feedback'); feedback.setAttribute('role', 'alert'); menu.append(feedback);
          for (const control of menu.querySelectorAll<HTMLButtonElement>('button')) control.disabled = false;
        }
      });
      return button;
    };
    menu.append(heading, close, element('p', 'Seen it', 'label'), option(model.observation.mediaType === 'series' ? 'Watched so far' : 'Watched', 'watched', !!mark?.watched, { watched: !mark?.watched }),
      element('hr', undefined, 'divider'), element('p', 'Your plan', 'label'),
      option('Want to watch', 'want', mark?.plan === 'want', { plan: mark?.plan === 'want' ? 'none' : 'want' }),
      option('Won’t watch', 'pass', mark?.plan === 'pass', { plan: mark?.plan === 'pass' ? 'none' : 'pass' }));
    if (mark?.plan && mark.plan !== 'none') menu.append(option('Clear plan', undefined, false, { plan: 'none' }, true));
    if (mark && hasMarks(mark)) menu.append(element('hr', undefined, 'divider'), option('Clear all marks', undefined, false, { watched: false, plan: 'none' }, true));
    menu.addEventListener('keydown', event => {
      if (event.key === 'Tab') { this.close(false); return; }
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('.choice:not(:disabled)'));
      const current = buttons.indexOf(menuRoot.activeElement as HTMLButtonElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
    });
    model.anchor.setAttribute('aria-expanded', 'true'); menuRoot.append(menu);
    this.positionMenu(menu, menuHost, model.anchor, owner ?? undefined);
    menu.querySelector<HTMLButtonElement>('.choice')?.focus({ preventScroll: true });
  }
  private positionMenu(menu: HTMLElement, host: HTMLElement, button: HTMLElement, owner?: HTMLElement): void {
    const anchor = button.getBoundingClientRect();
    if (!owner) {
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(anchor.right - box.width, innerWidth - box.width - 12))}px`;
      menu.style.top = `${anchor.bottom + 6 + box.height <= innerHeight - 12 ? anchor.bottom + 6 : Math.max(12, anchor.top - box.height - 6)}px`;
      return;
    }
    // A transformed Netflix preview establishes a containing block. Map viewport
    // measurements into its local CSS coordinates rather than treating them as
    // fixed screen coordinates. This covers native translate/scale and CSS zoom.
    const box = host.getBoundingClientRect();
    const scaleX = box.width / Math.max(1, host.clientWidth), scaleY = box.height / Math.max(1, host.clientHeight);
    // The owner's content may already be scrolled before the menu mounts.
    // Its host then moves with that content, while the owner's clipping box
    // stays put. Project the visible owner/viewport intersection into the host.
    const clip = owner.getBoundingClientRect();
    const left = Math.max((clip.left - box.left) / scaleX + 8, (12 - box.left) / scaleX);
    const right = Math.min((clip.right - box.left) / scaleX - 8, (innerWidth - 12 - box.left) / scaleX);
    const top = Math.max((clip.top - box.top) / scaleY + 8, (12 - box.top) / scaleY);
    const bottom = Math.min((clip.bottom - box.top) / scaleY - 8, (innerHeight - 12 - box.top) / scaleY);
    const width = Math.max(1, Math.min(260, right - left)); menu.style.width = `${width}px`; menu.style.maxWidth = `${width}px`;
    const anchorTop = (anchor.top - box.top) / scaleY, anchorBottom = (anchor.bottom - box.top) / scaleY;
    const below = Math.max(0, bottom - Math.max(top, anchorBottom + 6)), above = Math.max(0, Math.min(bottom, anchorTop - 6) - top);
    const naturalHeight = menu.getBoundingClientRect().height / scaleY;
    const placeBelow = below >= Math.min(160, naturalHeight) || below >= above;
    const available = Math.max(1, placeBelow ? below : above);
    menu.style.maxHeight = `${available}px`;
    const height = Math.min(naturalHeight, available);
    menu.style.left = `${Math.max(left, Math.min((anchor.right - box.left) / scaleX - width, right - width))}px`;
    menu.style.top = `${placeBelow ? Math.max(top, anchorBottom + 6) : Math.max(top, Math.min(bottom, anchorTop - 6) - height)}px`;
  }
  close(returnFocus = false): void {
    releasePanel(this);
    const anchor = this.model?.anchor;
    anchor?.setAttribute('aria-expanded', 'false'); this.menuHost?.remove(); this.menuHost = undefined; this.menu = undefined; this.model = undefined;
    if (returnFocus && anchor?.isConnected && !anchor.hidden) anchor.focus({ preventScroll: true });
  }
  notify(message: string, undo?: () => Promise<void>): void {
    clearTimeout(this.timer); this.toast?.remove(); this.expiresAt = Date.now() + 8000;
    const toast = element('div', undefined, 'toast'); this.toast = toast; toast.setAttribute('role', 'status');
    toast.append(element('span', message));
    if (undo) {
      const button = element('button', 'Undo'); button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await undo(); if (this.toast === toast) this.notify('Previous marks restored.'); }
        catch (error) { if (this.toast === toast) { toast.classList.add('error'); toast.replaceChildren(element('span', error instanceof Error ? error.message : 'This title changed elsewhere. Open its marks to edit.')); } }
      }); toast.append(button);
    }
    const schedule = () => { clearTimeout(this.timer); this.timer = setTimeout(() => { if (this.toast === toast) { toast.remove(); this.toast = undefined; } }, Math.max(1000, this.expiresAt - Date.now())); };
    toast.addEventListener('mouseenter', () => clearTimeout(this.timer)); toast.addEventListener('focusin', () => clearTimeout(this.timer));
    toast.addEventListener('mouseleave', () => { this.expiresAt = Date.now() + 3000; schedule(); });
    toast.addEventListener('focusout', () => { this.expiresAt = Date.now() + 3000; schedule(); });
    this.root.append(toast); schedule();
  }
  dispose(): void { this.close(false); clearTimeout(this.timer); this.host.remove(); document.removeEventListener('pointerdown', this.outside, true); document.removeEventListener('keydown', this.key, true); }
}
