import type { Candidate, RatingRecord, TitleObservation } from './contracts';

export function normaliseTitle(title: string): string {
  return title.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[‐‑–—]/g, '-').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Semantic serialization, deliberately independent of observation timestamps. */
export function observationFingerprint(o: TitleObservation): string {
  return JSON.stringify([o.ref.platformId, o.ref.titleId, normaliseTitle(o.displayTitle), o.mediaType,
    o.year?.value ?? null, o.year?.meaning ?? null,
    [...new Set((o.aliases ?? []).map(normaliseTitle))].sort(), o.adapterVersion,
    ...(o.credits ? [[o.credits.directors.map(normaliseTitle).sort(), o.credits.actors.map(normaliseTitle).sort()]] : []),
    ...(o.seasonCount === undefined ? [] : [o.seasonCount])]);
}

export function usableYear(o: TitleObservation): number | undefined {
  return ((o.mediaType === 'movie' && o.year?.meaning === 'movie_release') ||
    (o.mediaType === 'series' && o.year?.meaning === 'series_start')) ? o.year?.value : undefined;
}
export function hasStrongEvidence(o: TitleObservation): boolean {
  return o.mediaType !== 'unknown' && usableYear(o) !== undefined;
}
export function contradicts(o: TitleObservation, record: Pick<RatingRecord, 'mediaType' | 'year'>): boolean {
  return (o.mediaType !== 'unknown' && o.mediaType !== record.mediaType) ||
    (usableYear(o) !== undefined && Number(record.year.slice(0, 4)) !== usableYear(o));
}
export function supportedCandidate(o: TitleObservation, candidate: Candidate): boolean {
  const titles = [o.displayTitle, ...(o.aliases ?? [])].map(normaliseTitle);
  return hasStrongEvidence(o) && titles.includes(normaliseTitle(candidate.title)) &&
    !contradicts(o, candidate);
}
export function parseImdbInput(input: string): string | null {
  const text = input.trim();
  if (/^tt\d{7,12}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || !['imdb.com', 'www.imdb.com'].includes(url.hostname) ||
      url.username || url.password || url.port) return null;
    return url.pathname.match(/^\/title\/(tt\d{7,12})\/?$/)?.[1] ?? null;
  } catch { return null; }
}
