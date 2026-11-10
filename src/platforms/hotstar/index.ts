import type { TitleObservation } from '../../shared/contracts';
import { validateFilmCredits } from '../../shared/edition';
import { normaliseTitle } from '../../shared/identity';
import type { StreamingPlatformAdapter } from '../contracts';
import { hotstarPosterBinding, hotstarPosterKey, rememberHotstarPoster, restoreHotstarPosters } from './poster-memory';
import { HOTSTAR_ORIGIN, hotstarBrowseSurface, hotstarTitlePath } from './routes';

const LINK = 'a[data-testid="link"][href]';
const HOVER = '[data-testid="tray-card-hover"]';
const DETAIL = '[data-testid="dt-hero-id"]';
const FEATURED = '[aria-label="Featured Content"]';
const IMAGE = '[data-testid="hs-image"] img';
const TITLE_CUTOUT = '[data-testid="card-hover-title-cutout"]';
const PREVIEW = '[data-testid="card-hover-container"]';
const SEARCH_HERO = '[data-testid="search-hero"]';
const DEFAULT = '[data-testid="tray-card-default"]';
const ACTION = '[data-testid="action"][aria-label]';
const TILES = `${LINK},${HOVER},${DETAIL},${FEATURED},${DEFAULT}`;
const METADATA_SCOPE = `${TILES},${SEARCH_HERO}`;
const VERSION = 2;

type Work = NonNullable<ReturnType<typeof hotstarTitlePath>>;
interface WorkLabel { title: string; mediaType: Work['mediaType'] }
interface PosterIdentity extends WorkLabel { key: string; image: HTMLImageElement }
interface ShownMetadata { year?: number; seasonCount?: number }
let coveredCards = new WeakMap<HTMLElement, HTMLElement>();

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

function painted(element: HTMLElement): boolean {
  return element.isConnected && !element.closest('[hidden],[inert]') &&
    element.getClientRects().length > 0 && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
}

function rendered(element: HTMLElement): boolean {
  return !element.closest('[aria-hidden="true"]') && painted(element);
}

function metadataTags(tile: HTMLElement): string[] {
  return [...tile.querySelectorAll<HTMLElement>('span[data-testid="textTag"]')].flatMap(tag => {
    const scope = tag.closest(METADATA_SCOPE);
    if (!(scope === tile || (scope?.matches(SEARCH_HERO) && scope.closest(TILES) === tile))) return [];
    const label = text(tag.textContent);
    if (!label || !painted(tag)) return [];
    const hidden = tag.closest('[aria-hidden="true"]');
    if (hidden) {
      // Hotstar duplicates its visually rendered hero tags in an accessible
      // group label. Accept only a tag explicitly repeated by that same group.
      const group = hidden.parentElement?.closest<HTMLElement>('[aria-label]');
      if (!group || group === scope || !scope.contains(group) || !rendered(group) ||
        !group.getAttribute('aria-label')?.split(',').some(part => text(part) === label)) return [];
    }
    return [label];
  });
}

function uniqueNumber(values: Array<number | undefined>): number | undefined {
  const known = new Set(values.filter((value): value is number => value !== undefined));
  return known.size === 1 ? [...known][0] : undefined;
}

function shownMetadata(tile: HTMLElement, mediaType: Work['mediaType']): ShownMetadata {
  const tags = metadataTags(tile);
  const year = uniqueNumber(tags.map(yearValue));
  if (mediaType === 'movie') return { year };
  const seasonCount = uniqueNumber(tags.map(tag => {
    const match = tag.match(/^([1-9]\d{0,2}) Seasons?$/i);
    const count = Number(match?.[1]);
    return count > 0 && count <= 200 ? count : undefined;
  }));
  return year && seasonCount ? { year, seasonCount } : {};
}

function workLabel(node: Element, progress = false): WorkLabel | null {
  const label = text(node.getAttribute('aria-label'));
  const match = label?.match(progress ? /^(.+?),\s*(Show|Movie),\s*.+$/i : /^(.+?),\s*(Show|Movie)$/i);
  const title = text(match?.[1]);
  return match && title ? { title, mediaType: match[2].toLowerCase() === 'show' ? 'series' : 'movie' } : null;
}

function progressOwner(tile: HTMLElement): { link: HTMLElement; work: Work; title: string } | null {
  const link = tile.parentElement?.closest<HTMLElement>(LINK);
  const label = link && workLabel(link, true);
  if (!link || !label) return null;
  const work = linkedWork(link, true);
  return work && label.mediaType === work.mediaType ? { link, work, title: label.title } : null;
}

function publicPosterAsset(image: HTMLImageElement): string | null {
  try {
    const url = new URL(image.currentSrc || image.getAttribute('src') || '', HOTSTAR_ORIGIN);
    if (url.origin !== 'https://img10.hotstar.com' || url.username || url.password) return null;
    return url.pathname.match(/\/sources\/r1\/cms\/prod\/\d{1,12}\/([A-Za-z0-9_-]{1,100}(?:\.[A-Za-z0-9]{1,5})?)$/)?.[1] ?? null;
  } catch { return null; }
}

function posterAction(tile: HTMLElement): HTMLElement | null {
  const actions = [...tile.querySelectorAll<HTMLElement>(ACTION)].filter(action => action.closest(DEFAULT) === tile && !action.closest(HOVER));
  return actions.length === 1 ? actions[0] : null;
}

function posterIdentity(tile: HTMLElement): PosterIdentity | null {
  const action = posterAction(tile);
  if (!action) return null;
  const label = workLabel(action);
  if (!label) return null;
  const normalised = normaliseTitle(label.title);
  const artwork = [...action.querySelectorAll<HTMLImageElement>(IMAGE)].filter(image =>
    normaliseTitle(image.alt) === normalised && !image.closest(TITLE_CUTOUT));
  if (artwork.length !== 1) return null;
  const asset = publicPosterAsset(artwork[0]);
  return asset ? { ...label, key: hotstarPosterKey(asset, label.title, label.mediaType), image: artwork[0] } : null;
}

function coversPoster(hover: DOMRect, poster: DOMRect): boolean {
  if (poster.width < 76 || poster.height < 38) return false;
  const width = Math.min(hover.right, poster.right) - Math.max(hover.left, poster.left);
  const height = Math.min(hover.bottom, poster.bottom) - Math.max(hover.top, poster.top);
  return width > 0 && height > 0 && width * height >= poster.width * poster.height * 0.7;
}

function learnPoster(hover: HTMLElement, work: Work, displayTitle: string): void {
  const owner = hover.parentElement;
  const row = owner?.parentElement;
  if (!owner?.matches('[role="button"]') || !row || owner.querySelectorAll(HOVER).length !== 1) return;
  const trays = [...row.children].filter(child => child !== owner && child.querySelector(DEFAULT));
  if (trays.length !== 1) return;
  const bounds = hover.getBoundingClientRect();
  const title = normaliseTitle(displayTitle);
  const cutout = cutoutTitle(hover);
  if (!cutout || normaliseTitle(cutout) !== title) return;
  const matches = [...trays[0].querySelectorAll<HTMLElement>(DEFAULT)].filter(tile => {
    const action = posterAction(tile);
    if (!action) return false;
    const label = workLabel(action);
    return label?.mediaType === work.mediaType && normaliseTitle(label.title) === title && coversPoster(bounds, action.getBoundingClientRect());
  });
  if (matches.length !== 1) return;
  const tile = matches[0];
  const identity = posterIdentity(tile);
  if (!identity || !coversPoster(bounds, identity.image.getBoundingClientRect())) return;
  coveredCards.set(tile, hover);
  rememberHotstarPoster(identity.key, { work, metadata: shownMetadata(hover, work.mediaType) });
}

function isCovered(tile: HTMLElement): boolean {
  const card = tile.closest<HTMLElement>(DEFAULT);
  const hover = card && coveredCards.get(card);
  return !!hover && hover.parentElement?.parentElement?.contains(card) === true && rendered(hover);
}

function cutoutTitle(scope: HTMLElement): string | undefined {
  const cutout = scope.querySelector<HTMLElement>(TITLE_CUTOUT);
  if (!cutout || !rendered(cutout)) return;
  const candidates = [...cutout.querySelectorAll<HTMLElement>('img[alt],[data-testid="image-fallback-text"]')];
  const labels = new Map<string, string>();
  for (const node of candidates) {
    if (!rendered(node)) continue;
    const label = text(node.matches('img') ? node.getAttribute('alt') : node.textContent);
    if (label) labels.set(normaliseTitle(label), label);
  }
  return labels.size === 1 ? labels.values().next().value : undefined;
}

function labelFrom(scope: HTMLElement): string | undefined {
  const image = (within: Element | null) => text(within?.querySelector('img[alt]')?.getAttribute('alt'));
  const search = scope.querySelector(SEARCH_HERO);
  const searchTitles = search ? [...search.querySelectorAll<HTMLElement>('p.TITLE2')].filter(rendered) : [];
  const searchTitle = searchTitles.length === 1 ? text(searchTitles[0].textContent) : undefined;
  const heading = scope.querySelector('h1,h2');
  return cutoutTitle(scope) ?? searchTitle ??
    text(heading?.textContent) ?? image(heading) ?? image(scope.querySelector('[data-testid="autoplay-trailer-image-container"]')) ??
    text(scope.querySelector(`${IMAGE}[alt]`)?.getAttribute('alt'));
}

function fromWork(work: Work, displayTitle: string, { year, seasonCount }: ShownMetadata = {}): TitleObservation {
  return { ref: { platformId: 'hotstar', titleId: work.titleId }, displayTitle, mediaType: work.mediaType,
    pagePath: work.pagePath, adapterVersion: VERSION,
    ...(year && (work.mediaType === 'movie' || seasonCount) ? { year: { value: year, meaning: work.mediaType === 'movie' ? 'movie_release' : 'season_release' } } : {}),
    ...(work.mediaType === 'series' && year && seasonCount ? { seasonCount } : {}) };
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
  const { year: shownYear, seasonCount } = shownMetadata(tile, work.mediaType);
  const year = structuredYear && shownYear && structuredYear !== shownYear ? undefined : structuredYear ?? shownYear;
  const observation = fromWork(work, displayTitle, { year, seasonCount });
  const names = (value: unknown, limit: number) => Array.isArray(value) ? value.slice(0, limit)
    .flatMap(person => record(person) && typeof person.name === 'string' ? [person.name] : []) : [];
  const credits = data && validateFilmCredits({ directors: names(data.director, 10), actors: names(data.actor, 12) });
  if (credits && (credits.actors.length || credits.directors.length)) observation.credits = credits;
  return observation;
}

function expandedWork(tile: HTMLElement): { work: Work; title: string } | null {
  const progress = tile.matches(HOVER) ? progressOwner(tile) : null;
  const candidates = new Map<string, Work>();
  if (progress) candidates.set(progress.work.pagePath, progress.work);
  for (const anchor of tile.querySelectorAll(LINK)) {
    const work = linkedWork(anchor, true);
    if (work) candidates.set(work.pagePath, work);
  }
  const title = progress?.title ?? labelFrom(tile);
  if (!title || candidates.size !== 1) return null;
  return { work: [...candidates.values()][0], title };
}

function observation(tile: HTMLElement): TitleObservation | null {
  if (tile.matches(DETAIL)) return detailObservation(tile);
  if (tile.matches(`${HOVER},${FEATURED}`)) {
    if (!rendered(tile)) return null;
    const expanded = expandedWork(tile);
    return expanded ? fromWork(expanded.work, expanded.title, shownMetadata(tile, expanded.work.mediaType)) : null;
  }
  if (tile.matches(DEFAULT)) {
    if (isCovered(tile) || [...tile.querySelectorAll(LINK)].some(anchor => !anchor.closest(HOVER) && linkedWork(anchor, false))) return null;
    const identity = posterIdentity(tile);
    const learned = identity && hotstarPosterBinding(identity.key);
    return identity && learned ? fromWork(learned.work, identity.title, learned.metadata ?? undefined) : null;
  }
  if (!tile.matches(LINK) || tile.closest(`${HOVER},${DETAIL},${FEATURED}`) || isCovered(tile)) return null;
  const label = text(tile.getAttribute('aria-label'));
  // Continue Watching exposes a work name plus an explicit Show/Movie label;
  // clips and episode-only link names cannot establish whole-work identity.
  const progress = workLabel(tile, true);
  const work = linkedWork(tile, !!progress);
  if (!work || progress && progress.mediaType !== work.mediaType) return null;
  if (progress && [...tile.querySelectorAll<HTMLElement>(HOVER)].some(hover => rendered(hover) && expandedWork(hover))) return null;
  if (!progress && !tile.querySelector(`${IMAGE},${SEARCH_HERO}`)) return null;
  const displayTitle = progress?.title ?? labelFrom(tile) ?? label;
  if (displayTitle) return fromWork(work, displayTitle, shownMetadata(tile, work.mediaType));
  // A textless logo can still accompany an exact search-hero work link.
  if (!tile.querySelector(SEARCH_HERO)) return null;
  const slug = work.pagePath.split('/')[3].replace(/-/g, ' ');
  return fromWork(work, slug.replace(/\b[a-z]/g, character => character.toUpperCase()), shownMetadata(tile, work.mediaType));
}

function mountTarget(tile: HTMLElement): HTMLElement | null {
  const progress = tile.matches(HOVER) ? progressOwner(tile) : null;
  const container = progress ? progress.link.parentElement : tile.matches(LINK) ? tile.parentElement : tile;
  return container && !container.closest('a,button,[role="link"]') ? container : null;
}

export const hotstarAdapter: StreamingPlatformAdapter = {
  id: 'hotstar', version: VERSION,
  supports: hotstarBrowseSurface,
  findTiles(root) {
    restoreHotstarPosters();
    const tiles = [...root.querySelectorAll<HTMLElement>(TILES)];
    coveredCards = new WeakMap();
    for (const hover of tiles) {
      if (!hover.matches(HOVER) || !rendered(hover)) continue;
      const expanded = expandedWork(hover);
      if (expanded && !progressOwner(hover)) learnPoster(hover, expanded.work, expanded.title);
    }
    return tiles.filter(tile => !!observation(tile));
  },
  observeTitle: observation,
  badgeContainer(tile) {
    const container = mountTarget(tile);
    if (!container) return null;
    const bounds = container.getBoundingClientRect();
    return bounds.width >= 76 && bounds.height >= 38 ? container : null;
  },
  badgeCorner(tile) {
    if (tile.matches(FEATURED)) return 'top-right';
    return tile.matches(`${HOVER},${DETAIL}`) ? 'top-left' : undefined;
  },
  expandedOwner(tile) { return tile.matches(`${HOVER},${DETAIL},${FEATURED}`) ? mountTarget(tile) ?? undefined : undefined; },
  artworkElement(tile) {
    const preview = tile.querySelector(PREVIEW) ?? tile;
    const artwork = preview.querySelector<HTMLElement>(`[data-testid="autoplay-trailer-image-container"] ${IMAGE}`) ?? preview.querySelector<HTMLElement>(IMAGE);
    return artwork && !artwork.closest(TITLE_CUTOUT) ? artwork : null;
  },
  visibleImdb(tile) {
    // The controller reads the score only after validating this tile's work observation.
    if (!tile.matches(TILES) || !rendered(tile)) return;
    return uniqueNumber(metadataTags(tile).map(tag => {
      const value = tag.match(/^IMDb (\d{1,2}(?:\.\d)?)$/)?.[1];
      const score = Number(value);
      return score > 0 && score <= 10 ? score : undefined;
    }));
  },
  visibleDetails() { return null; },
  isObscured(tile) {
    return (!!tile && isCovered(tile)) || [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some(dialog =>
      dialog.getBoundingClientRect().width > 0 && !dialog.closest('[aria-hidden="true"],[hidden]') && (!tile || !dialog.contains(tile)));
  },
};
