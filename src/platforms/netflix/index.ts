import type { StreamingPlatformAdapter } from '../contracts';
import { normaliseTitle } from '../../shared/identity';

const CARD = 'a:is([data-uia="standard-card"],[data-uia="progress-card"])[aria-label]';
const MODAL = '[data-uia="modal-motion-container-DETAIL_MODAL"]';
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

export const netflixAdapter: StreamingPlatformAdapter = {
  id: 'netflix', version: 2,
  supports(url) {
    return url.origin === 'https://www.netflix.com' &&
      (['/browse', '/search', '/browse/my-list'].includes(url.pathname) || /^\/browse\/genre\/\d+$/.test(url.pathname));
  },
  findTiles(root) { return Array.from(root.querySelectorAll<HTMLElement>(CARD)); },
  observeTitle(tile) {
    if (!tile.matches(CARD) || tile.closest(MODAL)) return null;
    const titleId = netflixTitleId(tile.getAttribute('href') ?? '');
    const displayTitle = tile.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim();
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
