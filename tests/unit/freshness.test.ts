import { describe, expect, it } from 'vitest';
import type { RatingRecord } from '../../src/shared/contracts';
import { DAY_MS, ratingCacheState, ratingFreshFor } from '../../src/shared/freshness';

const NOW = Date.UTC(2026, 10, 5, 12);
function record(overrides: Partial<RatingRecord> = {}): RatingRecord {
  return {
    subject: { namespace: 'imdb', id: 'tt1234567' },
    source: 'imdb', provider: 'omdb', title: 'Synthetic freshness fixture',
    year: '2026', mediaType: 'movie', score: 8.2, scale: 10,
    votes: 1234, fetchedAt: NOW,
    ...overrides,
  };
}

describe('age-aware rating refresh intervals', () => {
  it.each<[RatingRecord['mediaType'], string, number]>([
    ['movie', '2026', 7],
    ['movie', '2025', 30],
    ['movie', '1999', 30],
    ['movie', '1888', 30],
    ['movie', '2027', 7],
    ['movie', '0000', 7],
    ['movie', 'N/A', 7],
    ['movie', '', 7],
    ['movie', '25', 7],
    ['movie', '2025–2026', 7],
    ['series', '2020–2024', 30],
    ['series', '2020-2024', 30],
    ['series', '2020–2020', 30],
    ['series', '2020–2026', 7],
    ['series', '2020–2027', 7],
    ['series', '2020–', 7],
    ['series', '2020-', 7],
    ['series', '2020', 7],
    ['series', '2024–2020', 7],
    ['series', '2027–2028', 7],
    ['series', '0000–2024', 7],
    ['series', '2020–24', 7],
    ['series', 'N/A', 7],
    ['series', '', 7],
  ])('%s with provider year %j stays fresh for %i days', (mediaType, year, days) => {
    expect(ratingFreshFor(record({ mediaType, year }), NOW)).toBe(days * DAY_MS);
  });

  it.each<[RatingRecord['mediaType'], string]>([
    ['movie', '2026'], ['series', '2020–2026'],
  ])('uses the UTC calendar-year transition for %s %s', (mediaType, year) => {
    const title = record({ mediaType, year });
    expect(ratingFreshFor(title, Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(7 * DAY_MS);
    expect(ratingFreshFor(title, Date.UTC(2027, 0, 1, 0, 0, 0))).toBe(30 * DAY_MS);
  });

  it('uses the previous calendar year as an explicit approximation of an older movie', () => {
    expect(ratingFreshFor(record({ year: '2025' }), Date.UTC(2026, 0, 1))).toBe(30 * DAY_MS);
  });
});

describe.each([
  { label: 'weekly', year: '2026', days: 7 },
  { label: 'monthly', year: '2025', days: 30 },
])('$label cache boundaries', ({ year, days }) => {
  const ttl = days * DAY_MS;
  it.each([
    { age: 0, state: 'fresh' },
    { age: ttl - 1, state: 'fresh' },
    { age: ttl, state: 'fresh' },
    { age: ttl + 1, state: 'stale' },
    { age: ttl + 7 * DAY_MS, state: 'stale' },
    { age: ttl + 7 * DAY_MS + 1, state: 'expired' },
    { age: -1, state: 'expired' },
  ])('returns $state at fetched age $age ms', ({ age, state }) => {
    expect(ratingCacheState(record({ year, fetchedAt: NOW - age }), NOW)).toBe(state);
  });

  it('keeps a confirmed missing score fresh through the interval, without stale grace', () => {
    expect(ratingCacheState(record({ year, score: null, fetchedAt: NOW - ttl }), NOW)).toBe('fresh');
    expect(ratingCacheState(record({ year, score: null, fetchedAt: NOW - ttl - 1 }), NOW)).toBe('expired');
    expect(ratingCacheState(record({ year, score: null, fetchedAt: NOW - ttl - 7 * DAY_MS }), NOW)).toBe('expired');
  });
});

describe('invalid cache timestamps', () => {
  it.each([NaN, Infinity, -Infinity])('expires a nonfinite fetched timestamp %s', fetchedAt => {
    expect(ratingCacheState(record({ fetchedAt }), NOW)).toBe('expired');
  });
});
