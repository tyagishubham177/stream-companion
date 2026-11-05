import type { Candidate, RatingRecord, SearchResult } from '../shared/contracts';

export type ProviderErrorKind = 'key' | 'quota' | 'offline' | 'provider' | 'not_found';
export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, message: string) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (v: unknown, max = 300): string | undefined => typeof v === 'string' && v.length <= max ? v : undefined;
const imdbId = (v: unknown): v is string => typeof v === 'string' && /^tt\d{7,12}$/.test(v);

export function parseDetail(raw: unknown, expectedId: string, now: number): RatingRecord {
  if (!object(raw) || raw.Response !== 'True' || !imdbId(raw.imdbID) || raw.imdbID !== expectedId ||
    !text(raw.Title) || !text(raw.Year, 30) || !/^\d{4}(?:[–-]\d{0,4})?$/.test(raw.Year as string) ||
    typeof raw.Type !== 'string' || !['movie', 'series'].includes(raw.Type)) throw new ProviderError('provider', 'The rating service returned an unsupported title response.');
  let score: number | null = null;
  if (typeof raw.imdbRating === 'string' && /^\d{1,2}(?:\.\d+)?$/.test(raw.imdbRating)) {
    const n = Number(raw.imdbRating); if (Number.isFinite(n) && n >= 1 && n <= 10) score = n;
  }
  let votes: number | null = null;
  if (typeof raw.imdbVotes === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw.imdbVotes)) {
    const n = Number(raw.imdbVotes.replaceAll(',', '')); if (Number.isSafeInteger(n)) votes = n;
  }
  return { subject: { namespace: 'imdb', id: raw.imdbID }, source: 'imdb', provider: 'omdb',
    title: raw.Title as string, year: raw.Year as string, mediaType: raw.Type as 'movie' | 'series',
    score, scale: 10, votes, fetchedAt: now };
}
export function parseSearch(raw: unknown, page: number): SearchResult {
  if (!object(raw) || raw.Response !== 'True' || !Array.isArray(raw.Search) || raw.Search.length > 10 ||
    typeof raw.totalResults !== 'string' || !/^\d+$/.test(raw.totalResults)) throw new ProviderError('provider', 'The rating service returned an unsupported search response.');
  const candidates: Candidate[] = [];
  for (const value of raw.Search) {
    if (!object(value) || !imdbId(value.imdbID) || !text(value.Title) || !text(value.Year, 30)) throw new ProviderError('provider', 'The rating service returned invalid search results.');
    if (value.Type === 'movie' || value.Type === 'series') candidates.push({ id: value.imdbID, title: value.Title as string, year: value.Year as string, mediaType: value.Type });
    else if (value.Type !== 'episode' && value.Type !== 'game') throw new ProviderError('provider', 'The rating service returned an unknown title type.');
  }
  const total = Number(raw.totalResults);
  if (!Number.isSafeInteger(total) || total < raw.Search.length) throw new ProviderError('provider', 'The rating service returned an invalid search count.');
  return { candidates, total, page };
}

/** Worker-only client. URLs and upstream error strings never escape this module. */
export async function fetchOmdb(key: string, params: Record<string, string>, fetcher = fetch): Promise<unknown> {
  const url = new URL('https://www.omdbapi.com/');
  url.search = new URLSearchParams({ ...params, apikey: key, r: 'json' }).toString();
  let response: Response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(8000), credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }); }
  catch { throw new ProviderError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'provider', 'The rating service could not be reached. Try again later.'); }
  if (response.status === 401 || response.status === 403) throw new ProviderError('key', 'The OMDb key was rejected. Check the key in Settings.');
  if (response.status === 429) throw new ProviderError('quota', 'OMDb has paused requests for this key. Cached ratings are still available.');
  if (!response.ok) throw new ProviderError('provider', 'The rating service is temporarily unavailable.');
  if (!response.body) throw new ProviderError('provider', 'The rating service returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 262144) { await reader.cancel(); throw new ProviderError('provider', 'The rating service response was too large.'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'provider', 'The rating service response was interrupted. Try again later.');
  }
  const data = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new ProviderError('provider', 'The rating service returned invalid data.'); }
  if (!object(raw) || !['True', 'False'].includes(String(raw.Response))) throw new ProviderError('provider', 'The rating service response format changed.');
  if (raw.Response === 'False') {
    const error = String(raw.Error ?? '').toLowerCase();
    if (/invalid api key|no api key|not activated/.test(error)) throw new ProviderError('key', 'The OMDb key was rejected. Check and activate it in Settings.');
    if (/request limit|too many|quota/.test(error)) throw new ProviderError('quota', 'OMDb has paused requests for this key. Cached ratings are still available.');
    if (/not found/.test(error)) throw new ProviderError('not_found', 'No title was found in OMDb for this request.');
    throw new ProviderError('provider', 'The rating service could not complete this request.');
  }
  return raw;
}
