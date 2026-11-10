import type { TitleObservation } from '../shared/contracts';
import { HOTSTAR_ORIGIN, hotstarObservationPath } from './hotstar/routes';

export function platformLabel(platformId: string): string {
  if (platformId === 'netflix') return 'Netflix';
  if (platformId === 'hotstar') return 'JioHotstar';
  return platformId;
}

export function platformTitleUrl(observation: Pick<TitleObservation, 'ref' | 'pagePath'>): string | null {
  const { platformId, titleId } = observation.ref;
  if (platformId === 'netflix' && /^\d{1,12}$/.test(titleId)) return `https://www.netflix.com/title/${titleId}`;
  if (platformId === 'hotstar') {
    const title = hotstarObservationPath(observation.pagePath);
    if (title?.titleId === titleId) return HOTSTAR_ORIGIN + title.pagePath;
  }
  return null;
}
