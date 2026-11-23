export const APPLE_TV_ORIGIN = 'https://tv.apple.com';
export const APPLE_TV_ID = /^umc\.cmc\.[a-z0-9]{22,25}$/;

interface AppleTitlePath {
  titleId: string;
  mediaType: 'movie' | 'series';
  pagePath: string;
}

const titlePath = /^(\/(?:[a-z]{2}\/)?)(movie|show|episode)\/(?:(?<slug>[\w.%~-]+)\/)?(?<id>umc\.cmc\.[a-z0-9]{22,25})\/?$/;

function appleOrigin(url: URL): boolean {
  return url.protocol === 'https:' && url.origin === APPLE_TV_ORIGIN && !url.username && !url.password;
}

function route(url: URL) {
  if (!appleOrigin(url)) return null;
  const match = titlePath.exec(url.pathname);
  if (!match?.groups) return null;
  if (match.groups.slug) {
    try {
      const slug = decodeURIComponent(match.groups.slug);
      if (/[\/\\\u0000-\u0020]/.test(slug) || slug === '.' || slug === '..') return null;
    } catch { return null; }
  }
  return { prefix: match[1], type: match[2], id: match.groups.id };
}

export function appleTitlePath(url: URL): AppleTitlePath | null {
  const work = route(url);
  if (!work || work.type === 'episode') return null;
  return { titleId: work.id, mediaType: work.type === 'movie' ? 'movie' : 'series', pagePath: url.pathname.replace(/\/$/, '') };
}

export function appleObservationPath(pagePath: unknown): AppleTitlePath | null {
  if (typeof pagePath !== 'string' || pagePath.length > 512 || !/^\/(?![\/\\])/.test(pagePath)) return null;
  const work = appleTitlePath(new URL(pagePath, APPLE_TV_ORIGIN));
  return work?.pagePath === pagePath ? work : null;
}

export function appleEpisodePath(url: URL): { episodeId: string; parentPath?: string } | null {
  const work = route(url);
  if (work?.type !== 'episode') return null;
  const parents = url.searchParams.getAll('showId');
  const parentPath = parents.length === 1 && APPLE_TV_ID.test(parents[0]) && parents[0] !== work.id
    ? `${work.prefix}show/${parents[0]}` : undefined;
  return { episodeId: work.id, parentPath };
}

export function appleBrowseSurface(url: URL): boolean {
  if (!appleOrigin(url)) return false;
  return /^\/(?:[a-z]{2}\/?|(?:[a-z]{2}\/)?search\/?|(?:[a-z]{2}\/)?(?:room|collection|shelf|channel|person)\/(?:[\w.%~-]+\/)?[\w.-]+\/?)?$/.test(url.pathname) ||
    appleTitlePath(url) !== null || appleEpisodePath(url) !== null;
}
