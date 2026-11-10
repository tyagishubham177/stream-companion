export const HOTSTAR_ORIGIN = 'https://www.hotstar.com';

const TITLE_PATH = /^\/in\/(movies|shows)\/([a-z0-9-]{1,180})\/(\d{1,12})\/?$/;
const CATALOGUE_PATH = /^\/in\/(?:home|explore|tv|movies|browse(?:\/[a-zA-Z0-9_-]{1,120}){1,4})\/?$/;

interface HotstarTitlePath {
  titleId: string;
  mediaType: 'movie' | 'series';
  pagePath: string;
}

export function hotstarTitlePath(url: URL): HotstarTitlePath | null {
  if (url.origin !== HOTSTAR_ORIGIN || url.username || url.password) return null;
  const match = url.pathname.match(TITLE_PATH);
  if (!match || !/[a-z0-9]/.test(match[2])) return null;
  const [, category, slug, titleId] = match;
  return { titleId, mediaType: category === 'movies' ? 'movie' : 'series', pagePath: `/in/${category}/${slug}/${titleId}` };
}

/** Stored paths contain only canonical title identity, without tracking parameters. */
export function hotstarObservationPath(pagePath: unknown): HotstarTitlePath | null {
  if (typeof pagePath !== 'string' || pagePath.length > 220 || !pagePath.startsWith('/in/')) return null;
  const title = hotstarTitlePath(new URL(pagePath, HOTSTAR_ORIGIN));
  return title?.pagePath === pagePath ? title : null;
}

export function hotstarBrowseSurface(url: URL): boolean {
  if (url.origin !== HOTSTAR_ORIGIN || url.username || url.password) return false;
  return CATALOGUE_PATH.test(url.pathname) || hotstarTitlePath(url) !== null;
}
