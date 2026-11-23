import type { TitleObservation } from '../shared/contracts';
import { HOTSTAR_ORIGIN, hotstarObservationPath } from './hotstar/routes';
import { APPLE_TV_ORIGIN, appleObservationPath } from './apple-tv/routes';

export const platformIdForOrigin = (origin: string): 'netflix' | 'hotstar' | 'apple-tv' | undefined => {
  if (origin === 'https://www.netflix.com') return 'netflix';
  if (origin === HOTSTAR_ORIGIN) return 'hotstar';
  if (origin === APPLE_TV_ORIGIN) return 'apple-tv';
};

export function platformLabel(platformId: string): string {
  if (platformId === 'netflix') return 'Netflix';
  if (platformId === 'hotstar') return 'JioHotstar';
  if (platformId === 'apple-tv') return 'Apple TV';
  return platformId;
}

export function platformTitleUrl(observation: Pick<TitleObservation, 'ref' | 'pagePath'>): string | null {
  const { platformId, titleId } = observation.ref;
  if (platformId === 'netflix' && /^\d{1,12}$/.test(titleId)) return `https://www.netflix.com/title/${titleId}`;
  if (platformId === 'hotstar') {
    const title = hotstarObservationPath(observation.pagePath);
    if (title?.titleId === titleId) return HOTSTAR_ORIGIN + title.pagePath;
  }
  if (platformId === 'apple-tv') {
    const title = appleObservationPath(observation.pagePath);
    if (title?.titleId === titleId) return APPLE_TV_ORIGIN + title.pagePath;
  }
  return null;
}
