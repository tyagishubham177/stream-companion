import type { RatingRecord } from './contracts';

export const DAY_MS = 86400000;
const WEEK = 7 * DAY_MS;
const MONTH = 30 * DAY_MS;

/** OMDb exposes release years, so age classification uses UTC calendar years. */
export function ratingFreshFor(record: Pick<RatingRecord, 'year' | 'mediaType'>, now = Date.now()): number {
  const currentYear = new Date(now).getUTCFullYear();
  if (record.mediaType === 'movie' && /^\d{4}$/.test(record.year)) {
    const year = Number(record.year);
    return year >= 1888 && year < currentYear ? MONTH : WEEK;
  }
  // A series start year alone says nothing about whether new episodes are arriving.
  if (record.mediaType === 'series') {
    const ended = record.year.match(/^(\d{4})[–-](\d{4})$/);
    if (ended) {
      const start = Number(ended[1]), end = Number(ended[2]);
      if (start >= 1888 && end >= start && end < currentYear) return MONTH;
    }
  }
  return WEEK;
}

export function ratingCacheState(record: Pick<RatingRecord, 'year' | 'mediaType' | 'score' | 'fetchedAt'>, now = Date.now()): 'fresh' | 'stale' | 'expired' {
  const age = now - record.fetchedAt;
  if (!Number.isFinite(age) || age < 0) return 'expired';
  const freshFor = ratingFreshFor(record, now);
  if (age <= freshFor) return 'fresh';
  return record.score !== null && age <= freshFor + WEEK ? 'stale' : 'expired';
}
