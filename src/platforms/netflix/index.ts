import type { StreamingPlatformAdapter } from '../contracts';
import { normaliseTitle } from '../../shared/identity';

const CARD = 'a:is([data-uia="standard-card"],[data-uia="progress-card"])[aria-label]';
const MODAL = '[data-uia="modal-motion-container-DETAIL_MODAL"]';
const PREVIEW = '[data-uia="modal-motion-container-MINI_MODAL"]';
const TITLE_ID = /^\d{1,12}$/;

export function netflixTitleId(href: string, base = 'https://www.netflix.com'): string | null {
  try {
    const url = new URL(href, base);
    if (url.origin !== 'https://www.netflix.com' || url.username || url.password) return null;
    // A watch URL can refer to an episode. It never establishes a series identity.
    if (!(url.pathname === '/browse' || url.pathname === '/search' || url.pathname === '/browse/my-list' || /^\/browse\/genre\/\d+$/.test(url.pathname))) return null;
    const ids = url.searchParams.getAll('jbv');
    return ids.length === 1 && TITLE_ID.test(ids[0]) ? ids[0] : null;
  } catch { return null; }
}

export function netflixPreviewTitleId(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.netflix.com');
    if (url.origin !== 'https://www.netflix.com' || url.username || url.password) return null;
    return url.pathname.match(/^\/title\/(\d{1,12})$/)?.[1] ?? null;
  } catch { return null; }
}

export const netflixAdapter: StreamingPlatformAdapter = {
  id: 'netflix', version: 2,
  supports(url) {
    return url.origin === 'https://www.netflix.com' &&
      (['/browse', '/search', '/browse/my-list'].includes(url.pathname) || /^\/browse\/genre\/\d+$/.test(url.pathname));
  },
  findTiles(root) { return Array.from(root.querySelectorAll<HTMLElement>(`${CARD},${PREVIEW}`)); },
  badgeContainer(tile) {
    if (tile.matches(PREVIEW)) {
      return tile.tagName === 'DIV' && tile.getAttribute('role') === 'dialog' &&
        !tile.closest('a,button,[role="button"],[role="link"]') &&
        tile.querySelectorAll('[data-uia="previewModal--player_container"]').length === 1 ? tile : null;
    }
    // Inspected standard/progress cards have a plain, card-sized DIV wrapper.
    // Fail closed on changed markup; never nest controls in a playback link.
    const parent = tile.parentElement;
    if (!parent || parent.tagName !== 'DIV' || parent.closest('a,button,[role="button"],[role="link"],[tabindex]') ||
      parent.querySelectorAll(CARD).length !== 1) return null;
    const card = tile.getBoundingClientRect(), wrapper = parent.getBoundingClientRect();
    if (card.width < 80 || card.height < 38 ||
      Math.abs(card.left - wrapper.left) > 1 || Math.abs(card.top - wrapper.top) > 1 ||
      Math.abs(card.right - wrapper.right) > 1 || Math.abs(card.bottom - wrapper.bottom) > 1) return null;
    return parent;
  },
  // The native close control/Netflix mark occupies the preview's upper right.
  badgeCorner(tile) { return tile.matches(PREVIEW) ? 'top-left' : undefined; },
  observeTitle(tile) {
    if (tile.closest(MODAL)) return null;
    let titleId: string | null;
    let displayTitle: string | undefined;
    if (tile.matches(PREVIEW)) {
      // A preview's Play URL may identify an episode. Only its title-level link
      // and scoped artwork label establish the work shown in the preview.
      const ids = new Set(Array.from(tile.querySelectorAll('a[href]')).flatMap(a => {
        const id = netflixPreviewTitleId(a.getAttribute('href') ?? ''); return id ? [id] : [];
      }));
      const labels = Array.from(tile.querySelectorAll<HTMLImageElement>('[data-uia="previewModal--player_container"] img[alt]'))
        .map(image => image.alt.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (ids.size !== 1 || new Set(labels.map(normaliseTitle)).size !== 1) return null;
      titleId = [...ids][0]; displayTitle = labels[0];
    } else {
      if (!tile.matches(CARD)) return null;
      titleId = netflixTitleId(tile.getAttribute('href') ?? '');
      displayTitle = tile.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim();
    }
    if (!titleId || !displayTitle || displayTitle.length > 300 || /[\u0000-\u001f]/.test(displayTitle)) return null;
    return { ref: { platformId: 'netflix', titleId }, displayTitle, mediaType: 'unknown', adapterVersion: 2 };
  },
  visibleDetails(observations) {
    const modal = document.querySelector<HTMLElement>(MODAL);
    const page = new URL(location.href);
    const titleId = netflixTitleId(location.href) ?? page.pathname.match(/^\/title\/(\d{1,12})$/)?.[1];
    if (!modal || !titleId || !modal.getBoundingClientRect().width) return null;
    const known = observations.find(o => o.ref.titleId === titleId);
    if (!known) return null;
    const labelledTitle = Array.from(modal.querySelectorAll<HTMLImageElement>('[data-uia="previewModal--player_container"] img[alt]'))
      .some(image => normaliseTitle(image.alt) === normaliseTitle(known.displayTitle));
    if (!labelledTitle) return null;
    // The inspected interface exposes latest-season dates. Never call them series start years.
    const series = Array.from(modal.querySelectorAll('h3')).some(h => h.textContent?.trim() === 'Episodes');
    if (series) return { ...known, mediaType: 'series' };
    const metadata = modal.querySelector('[data-uia="previewModal--detailsMetadata"]');
    const yearText = metadata?.querySelector('[data-uia="videoMetadata--container"] .videoMetadata--line > .year')?.textContent?.trim();
    const duration = metadata?.querySelector('[data-uia="videoMetadata--container"] span.duration')?.textContent?.trim();
    const explicitMovie = Array.from(modal.querySelectorAll('[data-uia="previewModal--tags-genre"]'))
      .some(e => e.textContent?.trim().startsWith('This Movie Is:'));
    // These exact hooks were inspected on a movie. A duration alone is not identity evidence.
    if (explicitMovie && duration && /^(?:\d+h(?: \d+m)?|\d+m)$/.test(duration) && yearText && /^(?:18|19|20|21)\d{2}$/.test(yearText)) {
      return { ...known, mediaType: 'movie', year: { value: Number(yearText), meaning: 'movie_release' } };
    }
    return null;
  },
  isObscured() {
    const modal = document.querySelector<HTMLElement>(MODAL);
    return !!modal && modal.getBoundingClientRect().width > 0;
  },
};
