export interface FilmCredits { directors: string[]; actors: string[] }

const normalise = (value: string) => value.normalize('NFC').replace(/[‘’]/g, "'").replace(/\s+/gu, ' ').trim().toLowerCase();
const separated = (value: string) => normalise(value).replace(/[\p{P}]/gu, ' ').replace(/\s+/gu, ' ').trim();
const labels = new Set(["raw & undekha", "director's cut", 'extended cut', 'extended edition', 'unrated', 'uncut', 'special edition', 'theatrical cut']);
const language = /^(?:hindi|english|tamil|telugu|malayalam|kannada)(?: dubbed| version)?$/;

/** A bounded search alias; never removes meaningful subtitles, sequel words or numerals. */
export function filmSearchAlias(title: string): string | null {
  if (typeof title !== 'string' || title.length > 300 || /[\u0000-\u001f]/.test(title)) return null;
  const suffix = title.match(/^(.*?)\s*\(([^()]*)\)\s*$/u);
  if (!suffix || !(labels.has(normalise(suffix[2])) || language.test(normalise(suffix[2])))) return null;
  const base = suffix[1].trim();
  return base && /[\p{L}\p{N}]/u.test(base) ? base : null;
}

/** This looser separator comparison is restricted to corroborated edition fallback. */
export function editionTitleMatches(base: string, title: string): boolean {
  return typeof base === 'string' && typeof title === 'string' && base.length <= 300 && title.length <= 300 &&
    !/[\u0000-\u001f]/.test(base + title) &&
    !!separated(base) && separated(base) === separated(title);
}

/** Validate optional public work credits without affecting otherwise usable title/rating data. */
export function validateFilmCredits(value: unknown): FilmCredits | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const names = (input: unknown, max: number): string[] | undefined => {
    if (!Array.isArray(input) || input.length > max) return undefined;
    if (input.some(name => typeof name !== 'string' || name.length > 120 || /[\u0000-\u001f<>]/.test(name) ||
      !/[\p{L}]/u.test(name) || ['n/a', 'unknown', 'none'].includes(normalise(name)))) return undefined;
    const seen = new Set<string>();
    return (input as string[]).map(name => name.trim()).filter(name => {
      const key = separated(name); if (!key || seen.has(key)) return false; seen.add(key); return true;
    });
  };
  const directors = names(object.directors, 10), actors = names(object.actors, 40);
  return directors && actors ? { directors, actors } : undefined;
}

export function corroboratesEdition(metadataCredits: FilmCredits | undefined, detailCredits: FilmCredits | undefined): boolean {
  const metadata = validateFilmCredits(metadataCredits), detail = validateFilmCredits(detailCredits);
  if (!metadata || !detail) return false;
  const overlaps = (left: string[], right: string[]) => {
    const source = new Set(left.map(separated)), target = new Set(right.map(separated));
    return [...source].filter(name => target.has(name)).length;
  };
  return overlaps(metadata.directors, detail.directors) >= 1 && overlaps(metadata.actors, detail.actors) >= 2;
}
