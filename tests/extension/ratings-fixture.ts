import { gzipSync } from 'node:zlib';
import { expect, type Route } from '@playwright/test';

export function ratingsFixture(rows: ReadonlyArray<readonly [id: string, score: string, votes?: number]>): Buffer {
  const header = 'tconst\taverageRating\tnumVotes\n';
  return gzipSync(header + [...rows].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, score, votes = 1234]) => `${id}\t${score}\t${votes}\n`).join(''));
}

export async function serveRatingsFixture(route: Route, body: Buffer): Promise<void> {
  const request = route.request();
  const headers = await request.allHeaders();
  expect(request.url()).toBe('https://datasets.imdbws.com/title.ratings.tsv.gz');
  expect(request.method()).toBe('GET');
  expect(request.serviceWorker()).not.toBeNull();
  for (const header of ['cookie', 'authorization', 'referer']) expect(headers[header]).toBeUndefined();
  await route.fulfill({ contentType: 'application/gzip', body });
}
