import type { StreamingPlatformAdapter } from '../contracts';
import type { TitleObservation } from '../../shared/contracts';
import { normaliseTitle } from '../../shared/identity';
import { appleBrowseSurface, appleEpisodePath, appleObservationPath, appleTitlePath } from './routes';

const LINKED_CARD = 'a:is([data-testid="lockup"],[data-testid="search-card-lockup"])';
const CONTINUE_CARD = 'a[data-testid="continue-watching-lockup"]';
const CARD = `:is(${LINKED_CARD},${CONTINUE_CARD})`;
const HERO = '[data-testid="epic-stage-item"],[data-testid="superhero-lockup"]';
const DETAIL = '[data-testid="product-header"]';
const PLAYER = '[data-testid="playback-view"] [data-testid="video-player"]';
const ADAPTER_VERSION = 1;

type Work = NonNullable<ReturnType<typeof appleTitlePath>>;

const clean = (text: string | null | undefined) => text?.replace(/\s+/gu, ' ').trim() ?? '';

function linkUrl(link: HTMLAnchorElement): URL | null {
  const href = link.getAttribute('href');
  if (!href) return null;
  try { return new URL(href, location.origin); } catch { return null; }
}

function observation(work: Work, displayTitle: string): TitleObservation | null {
  if (!displayTitle || displayTitle.length > 300) return null;
  return { ref: { platformId: 'apple-tv', titleId: work.titleId }, displayTitle, mediaType: work.mediaType,
    pagePath: work.pagePath, adapterVersion: ADAPTER_VERSION };
}

function cardName(link: HTMLAnchorElement): string {
  return clean(link.getAttribute('aria-label')) || clean(link.querySelector('.visually-hidden')?.textContent) ||
    clean(link.querySelector<HTMLImageElement>('img[alt]:not([alt=""])')?.alt);
}

function linkedCards(): Iterable<[Work, string]> {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>(LINKED_CARD)).flatMap(link => {
    const url = linkUrl(link), work = url && appleTitlePath(url), title = cardName(link);
    return work && title ? [[work, title]] : [];
  });
}

function slugText(title: string): string {
  return normaliseTitle(title).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function cardObservation(link: HTMLAnchorElement): TitleObservation | null {
  const url = linkUrl(link);
  if (!url) return null;
  const work = appleTitlePath(url), title = cardName(link);
  if (work) {
    if (!link.matches(CONTINUE_CARD)) return observation(work, title);
    for (const [candidate, name] of linkedCards()) {
      if (candidate.titleId === work.titleId && candidate.mediaType === work.mediaType) return observation(candidate, name);
    }
    // A resumed film appends a time remaining label to its title.
    const separator = title.lastIndexOf(', ');
    const trailing = separator < 0 ? '' : title.slice(separator + 2);
    return observation(work, /^\p{N}.*\p{L}/u.test(trailing) ? title.slice(0, separator) : title);
  }
  const parent = appleObservationPath(appleEpisodePath(url)?.parentPath);
  if (!parent) return null;
  for (const [candidate, name] of linkedCards()) {
    if (candidate.titleId === parent.titleId && candidate.mediaType === 'series') return observation(candidate, name);
  }
  // Continue Watching labels have the form “Series, Episode, S1, E2, …”.
  const labels = title.split(/,\s+/u);
  const slug = url.pathname.split('/').filter(Boolean).at(-2) ?? '';
  let episodeTitle = '';
  try { episodeTitle = slugText(decodeURIComponent(slug)); } catch { return null; }
  const episodeStart = labels.findIndex((part, index) => index > 0 && slugText(part) === episodeTitle);
  return episodeStart > 0 ? observation(parent, labels.slice(0, episodeStart).join(', ')) : null;
}

function structuredWork(type: 'Movie' | 'TVSeries' | 'Episode', name: string): Record<string, unknown> | undefined {
  const matches: Record<string, unknown>[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = script.textContent;
    if (!text || text.length > 262144) continue;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { continue; }
    const nodes = Array.isArray(raw) ? raw : [raw];
    for (const node of nodes) if (node?.['@type'] === type && typeof node.name === 'string' &&
      (type === 'Episode' ? node.name.endsWith(` - ${name}`) : normaliseTitle(node.name) === normaliseTitle(name))) matches.push(node);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function detailObservation(tile: HTMLElement): TitleObservation | null {
  const url = new URL(location.href), work = appleTitlePath(url);
  const title = clean(tile.querySelector('h1')?.textContent);
  if (work) {
    const result = observation(work, title);
    const metadata = result && structuredWork(work.mediaType === 'movie' ? 'Movie' : 'TVSeries', title);
    const date = metadata?.datePublished;
    const year = typeof date === 'string' && /^\d{4}(?:-\d{2}-\d{2}(?:T.*)?)?$/.test(date) ? Number(date.slice(0, 4)) : 0;
    if (result && year >= 1888 && year <= new Date().getUTCFullYear() + 5) {
      result.year = { value: year, meaning: work.mediaType === 'movie' ? 'movie_release' : 'series_start' };
    }
    return result;
  }
  const episode = appleEpisodePath(url);
  if (!episode || !title) return null;
  const subtitle = tile.querySelector('[data-testid="superhero-metadata-subtitle"]');
  const showLinks = Array.from(subtitle?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []).flatMap(link => {
    const href = linkUrl(link), show = href && appleTitlePath(href);
    return show?.mediaType === 'series' ? [{ show, name: clean(link.textContent) || cardName(link) }] : [];
  });
  if (showLinks.length === 1 && showLinks[0].name) return observation(showLinks[0].show, showLinks[0].name);
  if (showLinks.length > 1) return null;
  const metadata = structuredWork('Episode', title);
  const queryParent = appleObservationPath(episode.parentPath);
  if (queryParent && metadata?.identifier && queryParent.titleId !== metadata.identifier) return null;
  const expectedId = queryParent?.titleId ?? metadata?.identifier;
  const links = Array.from(tile.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap(link => {
    const href = linkUrl(link), parent = href && appleTitlePath(href);
    return parent?.mediaType === 'series' && parent.titleId === expectedId ? [parent] : [];
  });
  const parent = links[0] ?? queryParent;
  if (!parent) return null;
  if (typeof metadata?.name === 'string' && metadata.identifier === parent.titleId)
    return observation(parent, clean(metadata.name.slice(0, -` - ${title}`.length)));
  for (const [candidate, name] of linkedCards()) {
    if (candidate.titleId === parent.titleId && candidate.mediaType === 'series') return observation(candidate, name);
  }
  return null;
}

function heroObservation(tile: HTMLElement): TitleObservation | null {
  const title = clean(tile.getAttribute('aria-label')) || clean(tile.querySelector('[data-testid="content-title"]')?.textContent);
  const metadata = clean(tile.querySelector('[data-testid="superhero-metadata"] [data-testid="metadata-list"]')?.textContent);
  const type = metadata.match(/^(Movie|TV Show)\b/)?.[1];
  if (!title || !metadata) return null;
  const mediaType = type === 'Movie' ? 'movie' : type === 'TV Show' ? 'series' : undefined;
  const direct = Array.from(tile.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap(link => {
    const href = linkUrl(link), work = href && appleTitlePath(href);
    return work && (!mediaType || work.mediaType === mediaType) ? [work] : [];
  });
  const choices = direct.length ? direct : Array.from(linkedCards()).flatMap(([work, name]) =>
    (!mediaType || work.mediaType === mediaType) && normaliseTitle(name) === normaliseTitle(title) ? [work] : []);
  return choices.length && choices.every(work => work.titleId === choices[0].titleId) ? observation(choices[0], title) : null;
}

function observeTitle(tile: HTMLElement): TitleObservation | null {
  if (tile.matches(DETAIL)) return detailObservation(tile);
  if (tile.matches(CARD) && tile instanceof HTMLAnchorElement) return cardObservation(tile);
  return tile.matches(HERO) ? heroObservation(tile) : null;
}

function badgeContainer(tile: HTMLElement): HTMLElement | null {
  if (!tile.matches(CARD)) return tile;
  const parent = tile.parentElement;
  return parent && !parent.closest('a,button') && parent.querySelectorAll(`:scope > ${CARD}`).length === 1 ? parent : null;
}

export const appleTvAdapter: StreamingPlatformAdapter = {
  id: 'apple-tv',
  version: ADAPTER_VERSION,
  supports: appleBrowseSurface,
  findTiles: root => root.querySelectorAll<HTMLElement>(`${CARD},${DETAIL},${HERO}`),
  observeTitle,
  badgeContainer,
  badgeCorner: tile => tile.matches(DETAIL) || tile.matches(HERO) ? 'top-left' : undefined,
  artworkElement: tile => tile.matches(CARD) ? tile.querySelector<HTMLElement>('[data-testid="artwork"]') ?? tile.querySelector('picture') : null,
  expandedOwner: tile => tile.matches(DETAIL) || tile.matches(HERO) ? tile : undefined,
  visibleDetails: () => null,
  isObscured: () => Array.from(document.querySelectorAll(PLAYER)).some(player => !player.closest('[hidden],[inert],[aria-hidden="true"]')),
};
