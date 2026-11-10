import type { TitleObservation } from '../../shared/contracts';
import { validateFilmCredits } from '../../shared/edition';
import { normaliseTitle } from '../../shared/identity';
import type { StreamingPlatformAdapter } from '../contracts';
import { HOTSTAR_ORIGIN, hotstarBrowseSurface, hotstarTitlePath } from './routes';

const LINK = 'a[data-testid="link"][href]';
const HOVER = '[data-testid="tray-card-hover"]';
const DETAIL = '[data-testid="dt-hero-id"]';
const FEATURED = '[aria-label="Featured Content"]';
const IMAGE = '[data-testid="hs-image"] img';
const TITLE_CUTOUT = '[data-testid="card-hover-title-cutout"]';
const PREVIEW = '[data-testid="card-hover-container"]';
const SEARCH_HERO = '[data-testid="search-hero"]';
const VERSION = 1;

type Work = NonNullable<ReturnType<typeof hotstarTitlePath>>;
const text = (value: string | null | undefined): string | undefined => {
  const clean = value?.replace(/\s+/gu, ' ').trim();
  return clean && clean.length <= 300 && !/[\u0000-\u001f]/.test(clean) ? clean : undefined;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Playback URLs may carry a whole-work ID; never use the episode ID. */
function linkedWork(anchor: Element, playback: boolean): Work | null {
  try {
    const url = new URL(anchor.getAttribute('href') ?? '', HOTSTAR_ORIGIN);
    const detail = hotstarTitlePath(url);
    if (detail || !playback || url.origin !== HOTSTAR_ORIGIN || url.username || url.password) return detail;
    const movie = url.pathname.match(/^(\/in\/movies\/[a-z0-9-]+\/\d{1,12})\/watch\/?$/);
    const show = url.pathname.match(/^(\/in\/shows\/[a-z0-9-]+\/\d{1,12})(?:\/[a-z0-9-]+\/\d{1,12})?\/watch\/?$/);
    return movie || show ? hotstarTitlePath(new URL((movie ?? show)![1], HOTSTAR_ORIGIN)) : null;
  } catch { return null; }
}

function yearValue(value: unknown): number | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{4}$/.test(String(value).trim())) return;
  const year = Number(value);
  if (year >= 1888 && year <= new Date().getUTCFullYear() + 5) return year;
}

function movieYear(tile: HTMLElement): number | undefined {
  const years = new Set([...tile.querySelectorAll('[data-testid="textTag"]')]
    .map(e => yearValue(e.textContent)).filter((year): year is number => year !== undefined));
  return years.size === 1 ? [...years][0] : undefined;
}

function labelFrom(scope: HTMLElement): string | undefined {
  const image = (within: Element | null) => text(within?.querySelector('img[alt]')?.getAttribute('alt'));
  const cutout = scope.querySelector(TITLE_CUTOUT);
  const heading = scope.querySelector('h1,h2');
  return image(cutout) ?? text(cutout?.querySelector('[data-testid="image-fallback-text"]')?.textContent) ??
    text(heading?.textContent) ?? image(heading) ?? image(scope.querySelector('[data-testid="autoplay-trailer-image-container"]')) ??
    text(scope.querySelector(`${IMAGE}[alt]`)?.getAttribute('alt'));
}

function fromWork(work: Work, displayTitle: string, year?: number): TitleObservation {
  return { ref: { platformId: 'hotstar', titleId: work.titleId }, displayTitle, mediaType: work.mediaType,
    pagePath: work.pagePath, adapterVersion: VERSION,
    ...(work.mediaType === 'movie' && year ? { year: { value: year, meaning: 'movie_release' as const } } : {}) };
}

function detailObservation(tile: HTMLElement): TitleObservation | null {
  const work = hotstarTitlePath(new URL(location.href));
  if (!work) return null;
  const expected = work.mediaType === 'movie' ? 'Movie' : 'TVSeries';
  const nodes: Record<string, unknown>[] = [];
  for (const script of tile.ownerDocument.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent;
    if (!raw || raw.length > 160000) continue;
    let data: unknown;
    try { data = JSON.parse(raw); } catch { continue; }
    if (!record(data) || data['@type'] !== expected || typeof data.url !== 'string') continue;
    try {
      if (hotstarTitlePath(new URL(data.url))?.pagePath === work.pagePath) nodes.push(data);
    } catch { /* Invalid metadata URL is not usable evidence. */ }
  }
  const visible = labelFrom(tile);
  const data = nodes.length === 1 ? nodes[0] : undefined;
  const canonical = text(typeof data?.name === 'string' ? data.name : undefined);
  // SPA navigation can leave the old hero in the DOM while the URL changes.
  // Require a same-work link or bound metadata before decorating the hero.
  const linked = [...tile.querySelectorAll(LINK)].some(anchor => linkedWork(anchor, true)?.pagePath === work.pagePath);
  if (nodes.length > 1 || (!linked && (!canonical || !!visible && normaliseTitle(visible) !== normaliseTitle(canonical)))) return null;
  const displayTitle = canonical ?? visible;
  if (!displayTitle) return null;
  const structuredYear = work.mediaType === 'movie' ? yearValue(data?.releaseYear) : undefined;
  const shownYear = work.mediaType === 'movie' ? movieYear(tile) : undefined;
  const year = structuredYear && shownYear && structuredYear !== shownYear ? undefined : structuredYear ?? shownYear;
  const observation = fromWork(work, displayTitle, year);
  const names = (value: unknown, limit: number) => Array.isArray(value) ? value.slice(0, limit)
    .flatMap(person => record(person) && typeof person.name === 'string' ? [person.name] : []) : [];
  const credits = data && validateFilmCredits({ directors: names(data.director, 10), actors: names(data.actor, 12) });
  if (credits && (credits.actors.length || credits.directors.length)) observation.credits = credits;
  return observation;
}

function observation(tile: HTMLElement): TitleObservation | null {
  if (tile.matches(DETAIL)) return detailObservation(tile);
  if (tile.matches(`${HOVER},${FEATURED}`)) {
    const candidates = new Map<string, Work>();
    // Native preview links may sit outside the preview container but inside its owner.
    for (const anchor of tile.querySelectorAll(LINK)) {
      const work = linkedWork(anchor, true);
      if (work) candidates.set(work.pagePath, work);
    }
    const title = labelFrom(tile);
    if (!title || candidates.size !== 1) return null;
    return fromWork([...candidates.values()][0], title, movieYear(tile));
  }
  if (!tile.matches(LINK) || tile.closest(`${HOVER},${DETAIL},${FEATURED}`)) return null;
  const label = text(tile.getAttribute('aria-label'));
  // Continue Watching exposes a work name plus an explicit Show/Movie label;
  // clips and episode-only link names cannot establish whole-work identity.
  const progress = label?.match(/^(.+?),\s*(Show|Movie),\s*.+$/i);
  const work = linkedWork(tile, !!progress);
  if (!work || progress && (progress[2].toLowerCase() === 'show') !== (work.mediaType === 'series')) return null;
  if (!progress && !tile.querySelector(`${IMAGE},${SEARCH_HERO}`)) return null;
  const displayTitle = text(progress?.[1]) ?? labelFrom(tile) ?? label;
  if (displayTitle) return fromWork(work, displayTitle, movieYear(tile));
  // A visible search hero can have a textless logo. Its exact title link is
  // still usable for a direct ID lookup or marks, without guessing a year.
  if (!tile.querySelector(SEARCH_HERO)) return null;
  const slug = work.pagePath.split('/')[3].replace(/-/g, ' ');
  return fromWork(work, slug.replace(/\b[a-z]/g, character => character.toUpperCase()));
}

export const hotstarAdapter: StreamingPlatformAdapter = {
  id: 'hotstar', version: VERSION,
  supports: hotstarBrowseSurface,
  findTiles(root) { return Array.from(root.querySelectorAll<HTMLElement>(`${LINK},${HOVER},${DETAIL},${FEATURED}`)).filter(tile => !!observation(tile)); },
  observeTitle: observation,
  badgeContainer(tile) {
    const container = tile.matches(LINK) ? tile.parentElement : tile;
    if (!container || container.closest('a,button,[role="link"]')) return null;
    const bounds = container.getBoundingClientRect();
    return bounds.width >= 76 && bounds.height >= 38 ? container : null;
  },
  badgeCorner(tile) { return tile.matches(`${HOVER},${DETAIL},${FEATURED}`) ? 'top-left' : undefined; },
  expandedOwner(tile) { return tile.matches(`${HOVER},${DETAIL},${FEATURED}`) ? tile : undefined; },
  artworkElement(tile) {
    const preview = tile.querySelector(PREVIEW) ?? tile;
    const artwork = preview.querySelector<HTMLElement>(`[data-testid="autoplay-trailer-image-container"] ${IMAGE}`) ?? preview.querySelector<HTMLElement>(IMAGE);
    return artwork && !artwork.closest(TITLE_CUTOUT) ? artwork : null;
  },
  visibleDetails() { return null; },
  isObscured(tile) {
    return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some(dialog =>
      dialog.getBoundingClientRect().width > 0 && !dialog.closest('[aria-hidden="true"],[hidden]') && (!tile || !dialog.contains(tile)));
  },
};
