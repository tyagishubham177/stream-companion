import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { filmSearchAlias, editionTitleMatches, corroboratesEdition, validateFilmCredits } from '../../src/shared/edition';
import { parseDetail } from '../../src/providers/omdb';
import { NetflixMetadataResolver, parseNetflixMetadata } from '../../src/providers/netflix-metadata';
import { Repository } from '../../src/background/repository';

const credits = { directors: ['Aditya Dhar'], actors: ['Ranveer Singh', 'Arjun Rampal', 'R. Madhavan'] };
const detail = (extra = {}) => ({ Response: 'True', imdbID: 'tt1234567', Title: 'The Film: The Revenge', Year: '2026', Type: 'movie', imdbRating: '7.8', ...extra });
const person = (name: string) => ({ '@type': 'Person', name });
function page(extra = {}, additional = '') {
  const movie = { '@type': 'Movie', url: 'https://www.netflix.com/title/123', name: 'The Film The Revenge (Raw & Undekha)',
    director: credits.directors.map(person), actor: credits.actors.map(person), ...extra };
  return `<script type="application/ld+json">${JSON.stringify(movie)}</script>${additional}<div data-uia="metadata"><h2>The Film The Revenge (Raw &amp; Undekha)</h2><ul><li>2026</li></ul></div>`;
}

describe('bounded edition search aliases', () => {
  it('preserves the complete sequel title while removing a known trailing edition label', () => {
    expect(filmSearchAlias('Dhurandhar The Revenge (Raw & Undekha)')).toBe('Dhurandhar The Revenge');
    expect(editionTitleMatches('Dhurandhar The Revenge', 'Dhurandhar: The Revenge')).toBe(true);
    expect(editionTitleMatches('Dhurandhar The Revenge', 'Dhurandhar')).toBe(false);
  });
  it.each(["Director's Cut", 'Director’s Cut', 'Extended Cut', 'Extended Edition', 'Unrated', 'Uncut', 'Special Edition', 'Theatrical Cut', 'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Hindi Dubbed', 'English Version'])('strips only the whole trailing supported label %s', label => {
    expect(filmSearchAlias(`Chapter II: Part 2 (${label})`)).toBe('Chapter II: Part 2');
  });
  it.each(['The Film (The Revenge)', 'The Film (2026)', 'The Film (A True Story)', 'The Film (Part II)', 'The Film (Unrated Story)', 'The Film (Uncut) Part 2', '(Uncut)', 'The Film', 'The Film (Remastered)', 'The Film (Extended Cut Version)'])('preserves meaningful or unsupported parenthetical content: %s', title => {
    expect(filmSearchAlias(title)).toBeNull();
  });
  it('removes only one label, without recursively flattening arbitrary parentheticals', () => {
    expect(filmSearchAlias('The Film (The Revenge) (Hindi)')).toBe('The Film (The Revenge)');
    expect(filmSearchAlias('The Film (Uncut) (Hindi)')).toBe('The Film (Uncut)');
  });
  it('normalizes punctuation separators without deleting sequel tokens or meaningful words', () => {
    expect(editionTitleMatches('The Film — Part II', 'The Film: Part II')).toBe(true);
    expect(editionTitleMatches('The Film: Part 2', 'The Film Part 3')).toBe(false);
    expect(editionTitleMatches('The Film II', 'The Film 2')).toBe(false);
    expect(editionTitleMatches('The Film (The Revenge)', 'The Film')).toBe(false);
    expect(editionTitleMatches('The Film', 'A Film')).toBe(false);
    expect(editionTitleMatches('---', ':')).toBe(false);
    expect(editionTitleMatches('The\nFilm', 'The Film')).toBe(false);
  });
});

describe('independent public director and cast corroboration', () => {
  it('requires one common director and two distinct common cast members', () => {
    expect(corroboratesEdition(credits, { directors: ['Another Director', 'ADITYA DHAR'], actors: ['R. Madhavan', 'Ranveer Singh'] })).toBe(true);
    expect(corroboratesEdition(credits, { directors: ['Another Director'], actors: credits.actors })).toBe(false);
    expect(corroboratesEdition(credits, { directors: credits.directors, actors: ['Ranveer Singh'] })).toBe(false);
    expect(corroboratesEdition(undefined, credits)).toBe(false);
  });
  it('cannot count repeated names or punctuation variants as multiple cast matches', () => {
    expect(corroboratesEdition(credits, { directors: credits.directors, actors: ['R. Madhavan', 'R Madhavan', 'R. Madhavan'] })).toBe(false);
    expect(corroboratesEdition(credits, { directors: credits.directors, actors: ['R Madhavan', 'Arjun Rampal'] })).toBe(true);
  });
  it('does not guess nicknames, surnames, transliterations or diacritic equivalence', () => {
    expect(corroboratesEdition(credits, { directors: ['Dhar'], actors: ['Singh', 'Rampal'] })).toBe(false);
    expect(corroboratesEdition(credits, { directors: credits.directors, actors: ['Ranveer Singh', 'Madhavan'] })).toBe(false);
    expect(corroboratesEdition({ directors: ['Director'], actors: ['José Actor', 'Second Actor'] }, { directors: ['Director'], actors: ['Jose Actor', 'Second Actor'] })).toBe(false);
  });
  it.each([null, {}, { directors: 'Director', actors: [] }, { directors: ['N/A'], actors: ['Actor'] }, { directors: ['Director'], actors: [null] }, { directors: ['Director'], actors: [''] }, { directors: ['Director'], actors: ['Actor\nPrivate'] }, { directors: ['Director'], actors: Array(41).fill('Actor') }])('rejects malformed or unbounded optional credits %#', value => {
    expect(validateFilmCredits(value)).toBeUndefined();
  });
});

describe('provider credit extraction and legacy cache upgrades', () => {
  it('retains optional validated OMDb director and actor names', () => {
    expect(parseDetail(detail({ Director: 'Aditya Dhar', Actors: 'Ranveer Singh, Arjun Rampal, R. Madhavan' }), 'tt1234567', 100).credits).toEqual(credits);
  });
  it.each([{ Director: 'N/A', Actors: 'Ranveer Singh, Arjun Rampal' }, { Director: {}, Actors: 'Actor' }, { Director: 'Director', Actors: 'Actor,,Other Actor' }, { Director: 'Director', Actors: ['Actor'] }, { Director: 'x'.repeat(2001), Actors: 'Actor' }])('ignores invalid optional OMDb credits without weakening the base rating parser %#', extra => {
    const record = parseDetail(detail(extra), 'tt1234567', 100);
    expect(record.score).toBe(7.8); expect(record.credits).toBeUndefined();
  });
  it('extracts credits only from the exact canonical-bound Movie node', () => {
    expect(parseNetflixMetadata(page(), '123')).toMatchObject({ credits });
    const unrelated = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Movie', url: 'https://www.netflix.com/title/999', name: 'Other', director: [person('Wrong Director')], actor: [person('Wrong Actor')] })}</script>`;
    expect(parseNetflixMetadata(page({}, unrelated), '123')).toMatchObject({ credits });
  });
  it('supports singleton director objects and schema.org Person types', () => {
    expect(parseNetflixMetadata(page({ director: { '@type': 'https://schema.org/Person', name: 'Aditya Dhar' } }), '123')).toMatchObject({ credits });
  });
  it('reads the actual public Netflix plural roles for a Raw & Undekha edition', () => {
    const actors = ['Ranveer Singh', 'Arjun Rampal', 'Sanjay Dutt', 'R. Madhavan'];
    const parsed = parseNetflixMetadata(page({ director: undefined, actor: undefined, directors: [person('Aditya Dhar')], actors: actors.map(person) }), '123');
    expect(parsed).toMatchObject({ kind: 'matched', credits: { directors: ['Aditya Dhar'], actors } });
  });
  it('accepts equivalent singular/plural role sets regardless of order and duplicates', () => {
    expect(parseNetflixMetadata(page({ directors: [person('ADITYA DHAR')], actors: [...credits.actors].reverse().concat('Ranveer Singh').map(person) }), '123')).toMatchObject({ credits });
  });
  it.each([
    { directors: [person('Another Director')] },
    { actors: [person('Another Actor'), person('Arjun Rampal')] },
    { directors: 'Aditya Dhar' },
    { director: undefined, directors: undefined, creators: [person('Aditya Dhar')] },
  ])('rejects conflicting role fields and never treats creators as directors %#', extra => {
    const parsed = parseNetflixMetadata(page(extra), '123');
    expect(parsed.kind).toBe('matched'); if (parsed.kind === 'matched') expect(parsed.credits).toBeUndefined();
  });
  it.each([{ director: undefined }, { director: 'Aditya Dhar' }, { director: { '@type': 'Organization', name: 'Aditya Dhar' } }, { actor: [person('N/A')] }, { actor: Array(41).fill(person('Actor')) }, { actor: [{ '@type': 'Person', name: ['Actor'] }] }])('does not fabricate optional credits from malformed or unsupported JSON-LD %#', extra => {
    const parsed = parseNetflixMetadata(page(extra), '123');
    expect(parsed.kind).toBe('matched'); if (parsed.kind === 'matched') expect(parsed.credits).toBeUndefined();
  });
  it('upgrades legacy no-credit cache only when required, then retains genuine missing-credit cache', async () => {
    const repo = new Repository(`edition-${crypto.randomUUID()}`), now = Date.now();
    const key = JSON.stringify(['netflix-metadata', 'netflix', '123']);
    await repo.put('resolutions', key, { expiresAt: now + 86400000, result: { kind: 'matched', title: 'Legacy', year: 2026, mediaType: 'movie', checkedAt: now } });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(page({ director: undefined }), { headers: { 'Content-Type': 'text/html' } }));
    const resolver = new NetflixMetadataResolver(repo, async () => ({ enabled: true, cacheOnly: false }), fetcher);
    expect(await resolver.resolve({ platformId: 'netflix', titleId: '123' }, () => true)).toMatchObject({ title: 'Legacy' });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await resolver.resolve({ platformId: 'netflix', titleId: '123' }, () => true, true)).kind).toBe('matched');
    expect((await resolver.resolve({ platformId: 'netflix', titleId: '123' }, () => true, true)).kind).toBe('matched');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await repo.get('resolutions', key)).toMatchObject({ creditsChecked: true });
  });
});
