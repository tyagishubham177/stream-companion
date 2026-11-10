import type { StreamingPlatformAdapter } from '../contracts';
import type { TitleObservation } from '../../shared/contracts';
import { normaliseTitle } from '../../shared/identity';

const MODERN = 'a:is([data-uia="standard-card"],[data-uia="progress-card"])';
const CLASSIC = '.title-card a.slider-refocus,.title-card-container a.slider-refocus,a.title-card-link';
const CARD = `${MODERN},${CLASSIC}`;
const MODAL = '[data-uia="modal-motion-container-DETAIL_MODAL"]';
const PREVIEW = '[data-uia="modal-motion-container-MINI_MODAL"]';
const HERO = '[data-uia="previewModal--player_container"]';
const TITLE_ID = /^\d{1,12}$/;
const VERSION = 3;

/** Public authenticated catalogue surfaces; playback/account/profile pages are excluded. */
export function netflixBrowseSurface(url: URL): boolean {
  if (url.origin !== 'https://www.netflix.com' || url.username || url.password) return false;
  return /^\/(?:search|latest|new-and-popular|title\/\d{1,12}|browse(?:\/(?:my-list|my-netflix|originals|recently-added|popular|new-releases|original-audio|audio-description|audio|subtitles)|\/(?:genre|person)\/\d+|\/m\/(?:genre|person)\/\d+)?)\/?$/.test(url.pathname);
}

export function netflixTitleId(href: string, base = 'https://www.netflix.com'): string | null {
  try {
    const url = new URL(href, base);
    if (!netflixBrowseSurface(url)) return null;
    const pathId = url.pathname.match(/^\/title\/(\d{1,12})\/?$/)?.[1];
    const ids = url.searchParams.getAll('jbv');
    if (ids.length > 1 || (ids.length === 1 && !TITLE_ID.test(ids[0]))) return null;
    if (pathId) return !ids.length || ids[0] === pathId ? pathId : null;
    return ids.length === 1 ? ids[0] : null;
  } catch { return null; }
}

export function netflixPreviewTitleId(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.netflix.com');
    if (url.origin !== 'https://www.netflix.com' || url.username || url.password) return null;
    return url.pathname.match(/^\/title\/(\d{1,12})\/?$/)?.[1] ?? null;
  } catch { return null; }
}

const clean = (text: string | null | undefined): string => text?.replace(/\s+/g, ' ').trim() ?? '';
function uniqueLabel(labels: string[]): string | null {
  const values = labels.map(clean).filter(Boolean);
  return values.length && new Set(values.map(normaliseTitle)).size === 1 ? values[0] : null;
}
function cardLabel(tile: HTMLElement): string | null {
  const aria = clean(tile.getAttribute('aria-label'));
  if (aria) return aria;
  return uniqueLabel(Array.from(tile.querySelectorAll<HTMLImageElement>('img[alt]')).map(image => image.alt)) ??
    uniqueLabel(Array.from(tile.querySelectorAll('.fallback-text,.title-card-title')).map(node => node.textContent ?? ''));
}
/** A classic catalogue card may navigate directly to playback. Its scoped public
 * recommendation entity, not that watch URL alone, establishes the title ID. */
export function netflixCardTitleId(tile: HTMLElement): string | null {
  const href = tile.getAttribute('href') ?? '';
  const direct = netflixTitleId(href);
  if (direct) return direct;
  if (!tile.matches(CLASSIC) || !cardLabel(tile)) return null;
  const tracking = tile.closest<HTMLElement>('.ptrack-content[data-ui-tracking-context]');
  if (!tracking || !tracking.parentElement?.matches('.title-card') || tracking.closest(`${MODAL},${PREVIEW}`)) return null;
  const raw = tracking.getAttribute('data-ui-tracking-context');
  if (!raw || raw.length > 16384) return null;
  try {
    const url = new URL(href, 'https://www.netflix.com');
    if (url.origin !== 'https://www.netflix.com' || url.username || url.password) return null;
    const watchId = url.pathname.match(/^\/watch\/(\d{1,12})\/?$/)?.[1];
    if (!watchId) return null;
    const value: unknown = JSON.parse(raw.trim().startsWith('{') ? raw : decodeURIComponent(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entity = value as { video_id?: unknown; unifiedEntityId?: unknown };
    const id = typeof entity.video_id === 'number' && Number.isSafeInteger(entity.video_id) ? String(entity.video_id) : entity.video_id;
    return typeof id === 'string' && TITLE_ID.test(id) && id === watchId && entity.unifiedEntityId === `Video:${id}` ? id : null;
  } catch { return null; }
}
function modalIdentity(tile: HTMLElement): { titleId: string; displayTitle: string } | null {
  const heroes = Array.from(tile.querySelectorAll<HTMLElement>(HERO)).filter(hero => hero.closest(`${MODAL},${PREVIEW}`) === tile);
  if (heroes.length !== 1) return null;
  const hero = heroes[0];
  const ownLinks = Array.from(tile.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(anchor =>
    !anchor.closest('.title-card,.title-card-container') && anchor.closest(`${MODAL},${PREVIEW}`) === tile);
  const ids = new Set(ownLinks.flatMap(anchor => {
    const id = netflixPreviewTitleId(anchor.getAttribute('href') ?? ''); return id ? [id] : [];
  }));
  if (tile.matches(MODAL)) {
    const pageId = netflixTitleId(location.href);
    if (pageId) ids.add(pageId);
  }
  const labels = Array.from(hero.querySelectorAll<HTMLImageElement>('img[alt]')).map(image => image.alt);
  const displayTitle = uniqueLabel(labels) ?? uniqueLabel(Array.from(tile.querySelectorAll<HTMLImageElement>('[data-uia="previewModal--player-titleTreatmentWrapper"] img[alt]')).map(image => image.alt));
  return ids.size === 1 && displayTitle ? { titleId: [...ids][0], displayTitle } : null;
}
function observation(tile: HTMLElement): TitleObservation | null {
  let identity: { titleId: string; displayTitle: string } | null;
  if (tile.matches(`${PREVIEW},${MODAL}`)) identity = modalIdentity(tile);
  else {
    if (!tile.matches(CARD)) return null;
    const titleId = netflixCardTitleId(tile);
    const displayTitle = cardLabel(tile);
    identity = titleId && displayTitle ? { titleId, displayTitle } : null;
  }
  if (!identity || identity.displayTitle.length > 300 || /[\u0000-\u001f]/.test(identity.displayTitle)) return null;
  return { ref: { platformId: 'netflix', titleId: identity.titleId }, displayTitle: identity.displayTitle, mediaType: 'unknown', adapterVersion: VERSION };
}

export const netflixAdapter: StreamingPlatformAdapter = {
  id: 'netflix', version: VERSION,
  supports: netflixBrowseSurface,
  findTiles(root) {
    return Array.from(root.querySelectorAll<HTMLElement>(`${CARD},${PREVIEW},${MODAL}`)).filter(tile => {
      if (tile.matches(`${PREVIEW},${MODAL}`)) return true;
      const scope = tile.closest('.title-card,.title-card-container');
      if (!scope) return true;
      const anchors = Array.from(scope.querySelectorAll<HTMLElement>(CARD));
      const identities = new Set(anchors.map(netflixCardTitleId).filter(Boolean));
      return identities.size === 1 && (anchors.find(anchor => anchor.querySelector('img,.boxart-container')) ?? anchors[0]) === tile;
    });
  },
  badgeContainer(tile) {
    if (tile.matches(`${PREVIEW},${MODAL}`)) {
      return tile.tagName === 'DIV' && tile.getAttribute('role') === 'dialog' &&
        !tile.closest('a,button,[role="button"],[role="link"]') &&
        tile.querySelectorAll(HERO).length === 1 ? tile : null;
    }
    const card = tile.getBoundingClientRect();
    if (card.width < 80 || card.height < 38) return null;
    let parent = tile.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      if (parent.tagName !== 'DIV' || parent.closest('a,button,[role="button"],[role="link"],[tabindex]')) return null;
      const wrapper = parent.getBoundingClientRect();
      const ids = new Set(Array.from(parent.querySelectorAll<HTMLElement>(CARD)).map(netflixCardTitleId).filter(Boolean));
      if (ids.size > 1) return null;
      if (ids.size === 1 && Math.abs(card.left - wrapper.left) <= 1 && Math.abs(card.top - wrapper.top) <= 1 &&
        Math.abs(card.right - wrapper.right) <= 1 && Math.abs(card.bottom - wrapper.bottom) <= 1) return parent;
    }
    return null;
  },
  badgeCorner(tile) { return tile.matches(`${PREVIEW},${MODAL}`) ? 'top-left' : undefined; },
  expandedOwner(tile) { return tile.matches(`${PREVIEW},${MODAL}`) ? tile : undefined; },
  artworkElement(tile) {
    const scope = tile.matches(`${PREVIEW},${MODAL}`) ? tile.querySelector<HTMLElement>(HERO) : tile;
    if (!scope) return null;
    // Only the artwork image may be affected, never its control-bearing parent.
    const images = Array.from(scope.querySelectorAll<HTMLImageElement>('img')).filter(image =>
      !image.closest('[data-sc-root]') && !/logo|titleTreatment/i.test(image.className));
    return images.length === 1 ? images[0] : null;
  },
  observeTitle: observation,
  visibleDetails(observations) {
    const modal = document.querySelector<HTMLElement>(MODAL);
    if (!modal || !modal.getBoundingClientRect().width) return null;
    const own = observation(modal);
    const pageId = netflixTitleId(location.href);
    const known = own ?? observations.find(value => value.ref.titleId === pageId);
    if (!known) return null;
    const labelledTitle = Array.from(modal.querySelectorAll<HTMLImageElement>(`${HERO} img[alt]`))
      .some(image => normaliseTitle(image.alt) === normaliseTitle(known.displayTitle));
    if (!labelledTitle) return null;
    const series = Array.from(modal.querySelectorAll('h3')).some(heading => heading.textContent?.trim() === 'Episodes');
    if (series) return { ...known, mediaType: 'series' };
    const metadata = modal.querySelector('[data-uia="previewModal--detailsMetadata"]');
    const yearText = metadata?.querySelector('[data-uia="videoMetadata--container"] .videoMetadata--line > .year')?.textContent?.trim();
    const duration = metadata?.querySelector('[data-uia="videoMetadata--container"] span.duration')?.textContent?.trim();
    const explicitMovie = Array.from(modal.querySelectorAll('[data-uia="previewModal--tags-genre"]'))
      .some(element => element.textContent?.trim().startsWith('This Movie Is:'));
    if (explicitMovie && duration && /^(?:\d+h(?: \d+m)?|\d+m)$/.test(duration) && yearText && /^(?:18|19|20|21)\d{2}$/.test(yearText)) {
      return { ...known, mediaType: 'movie', year: { value: Number(yearText), meaning: 'movie_release' } };
    }
    return null;
  },
  isObscured(tile) {
    const modal = document.querySelector<HTMLElement>(MODAL);
    return !!modal && modal.getBoundingClientRect().width > 0 && (!tile || !modal.contains(tile));
  },
};
