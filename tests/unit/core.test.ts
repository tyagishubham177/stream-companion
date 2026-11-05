import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normaliseTitle, observationFingerprint, parseImdbInput, supportedCandidate } from '../../src/shared/identity';
import { authoriseCommand, authoriseSender, validateRequest } from '../../src/shared/validation';
import { DEFAULT_SETTINGS, titleKey, ratingKey, type Mapping, type RatingRecord, type TitleObservation } from '../../src/shared/contracts';
import { fetchOmdb, parseDetail, parseSearch, ProviderError } from '../../src/providers/omdb';
import { Repository, txPut } from '../../src/background/repository';
import { DeferredError, Scheduler } from '../../src/background/scheduler';
import { Resolver } from '../../src/background/resolver';
import type { Configuration } from '../../src/background/config';

const observation: TitleObservation = { ref: { platformId: 'netflix', titleId: '1001' }, displayTitle: 'Fixture Orbit', mediaType: 'movie', year: { value: 2020, meaning: 'movie_release' }, adapterVersion: 1 };
const raw = { Response: 'True', Title: 'Fixture Orbit', Year: '2020', Type: 'movie', imdbID: 'tt1234567', imdbRating: '8.2', imdbVotes: '1,234' };
const credential = { key: 'fixture_only', id: 'local-test-credential', version: 1 };
const record = (): RatingRecord => parseDetail(raw, raw.imdbID, Date.now());
let repo: Repository;
beforeEach(() => { repo = new Repository(`test-${crypto.randomUUID()}`); });

describe('identity and trust boundaries', () => {
  it('keeps sequels, subtitles and Unicode distinctions while normalising punctuation', () => {
    expect(normaliseTitle('  L’Avventura  ')).toBe("l'avventura");
    expect(normaliseTitle('Orbit 2')).not.toBe(normaliseTitle('Orbit'));
    expect(normaliseTitle('हाउस')).not.toBe(normaliseTitle('House'));
  });
  it('requires title, explicit corresponding year, type and an exact matching candidate', () => {
    const c = { id: raw.imdbID, title: raw.Title, year: raw.Year, mediaType: 'movie' as const };
    expect(supportedCandidate(observation, c)).toBe(true);
    expect(supportedCandidate({ ...observation, year: undefined }, c)).toBe(false);
    expect(supportedCandidate({ ...observation, year: { value: 2020, meaning: 'season_release' } }, c)).toBe(false);
    expect(supportedCandidate(observation, { ...c, year: '2021' })).toBe(false);
    expect(supportedCandidate(observation, { ...c, mediaType: 'series' })).toBe(false);
  });
  it('namespaces platform identities and includes semantic evidence in the fingerprint', () => {
    expect(titleKey(observation.ref)).not.toBe(titleKey({ platformId: 'future', titleId: '1001' }));
    expect(observationFingerprint(observation)).not.toBe(observationFingerprint({ ...observation, displayTitle: 'Fixture Orbit 2' }));
  });
  it.each(['http://www.imdb.com/title/tt1234567/', 'https://evil.test/title/tt1234567/', 'https://imdb.com.evil.test/title/tt1234567/', 'https://u:p@imdb.com/title/tt1234567/', 'tt123', 'https://www.imdb.com/title/tt1234567/other'])('rejects unsafe IMDb input %s', input => expect(parseImdbInput(input)).toBeNull());
  it('accepts a bounded ID or a canonical HTTPS IMDb title URL', () => {
    expect(parseImdbInput('tt1234567')).toBe('tt1234567');
    expect(parseImdbInput('https://www.imdb.com/title/tt1234567/?ref_=x')).toBe('tt1234567');
  });
  it('rejects unknown fields, oversized observations and coerced enums', () => {
    expect(() => validateRequest({ protocol: 1, type: 'LOOKUP', observation, url: 'https://evil.test' })).toThrow();
    expect(() => validateRequest({ protocol: 1, type: 'LOOKUP', observation: { ...observation, displayTitle: 'x'.repeat(301) } })).toThrow();
    expect(() => validateRequest({ protocol: 1, type: 'UPDATE_SETTINGS', settings: { corner: ['top-left'] } })).toThrow();
    expect(() => validateRequest({ protocol: 1, type: 'LOOKUP', observation: { ...observation, mediaType: ['movie'] } })).toThrow();
  });
  it('authorises top-frame Netflix senders and separates trusted page capabilities', () => {
    const sender = { id: 'ext', url: 'https://www.netflix.com/browse', frameId: 0, documentId: 'doc', tab: { id: 1 } } as chrome.runtime.MessageSender;
    expect(authoriseSender(sender, 'ext')).toBe('content');
    expect(() => authoriseSender({ ...sender, frameId: 1 }, 'ext')).toThrow();
    expect(() => authoriseSender({ ...sender, url: 'https://www.netflix.com/watch/1' }, 'ext')).toThrow();
    expect(() => authoriseSender({ ...sender, url: 'https://evil.test' }, 'ext')).toThrow();
    expect(() => authoriseCommand('content', 'SET_API_KEY')).toThrow();
    expect(() => authoriseCommand('popup', 'CONFIRM_MATCH')).toThrow();
  });
});

describe('provider data and failure handling', () => {
  it.each(['N/A', '', 'NaN', '11', '-1', '0', undefined])('does not invent a score for %s', score => {
    expect(parseDetail({ ...raw, imdbRating: score }, raw.imdbID, 1).score).toBeNull();
  });
  it('normalises scores and votes without treating a missing vote count as zero', () => {
    expect(record()).toMatchObject({ score: 8.2, votes: 1234, source: 'imdb', provider: 'omdb' });
    expect(parseDetail({ ...raw, imdbVotes: 'N/A' }, raw.imdbID, 1).votes).toBeNull();
  });
  it('rejects identity mismatches, episodes and coerced types', () => {
    expect(() => parseDetail(raw, 'tt9999999', 1)).toThrow();
    expect(() => parseDetail({ ...raw, Type: 'episode' }, raw.imdbID, 1)).toThrow();
    expect(() => parseDetail({ ...raw, Type: ['movie'] }, raw.imdbID, 1)).toThrow();
  });
  it('retains truncation evidence from search totals', () => {
    expect(parseSearch({ Response: 'True', Search: [{ Title: raw.Title, Year: raw.Year, Type: 'movie', imdbID: raw.imdbID }], totalResults: '15' }, 1).total).toBe(15);
  });
  it('classifies HTTP-200 key/quota errors and redacts upstream messages', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ Response: 'False', Error: 'Invalid API key! PRIVATE_CREDENTIAL' })));
    await expect(fetchOmdb('PRIVATE_CREDENTIAL', { i: raw.imdbID }, fetcher)).rejects.toMatchObject({ kind: 'key' });
    try { await fetchOmdb('PRIVATE_CREDENTIAL', {}, fetcher); } catch (e) { expect(String(e)).not.toContain('PRIVATE_CREDENTIAL'); }
  });
  it('classifies interrupted response bodies as provider failures', async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error('SECRET_URL')); } });
    await expect(fetchOmdb('fixture', {}, vi.fn(async () => new Response(stream)))).rejects.toMatchObject({ kind: 'provider' });
  });
  it('rejects malformed and oversized responses', async () => {
    await expect(fetchOmdb('fixture', {}, vi.fn(async () => new Response('{broken')))).rejects.toBeInstanceOf(ProviderError);
    await expect(fetchOmdb('fixture', {}, vi.fn(async () => new Response('x'.repeat(262145))))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('durable scheduling', () => {
  it('atomically reserves at most two leases across scheduler instances and enforces spacing', async () => {
    const a = new Scheduler(repo, async () => credential); const b = new Scheduler(repo, async () => credential);
    const now = Date.now();
    const first = await a.reserve(credential, false, false, now);
    const simultaneous = await b.reserve(credential, false, false, now);
    const second = await b.reserve(credential, false, false, now + 500);
    const third = await a.reserve(credential, false, false, now + 1000);
    expect(first).toHaveProperty('id'); expect(simultaneous).toMatchObject({ blocked: 'busy' });
    expect(second).toHaveProperty('id'); expect(third).toMatchObject({ blocked: 'busy' });
    expect((await repo.all('attempts')).length).toBe(2);
  });
  it('preserves the explicit-action reserve and charges a committed attempt after restart', async () => {
    const now = Date.now();
    await repo.transaction(['attempts'], async tx => { for (let i = 0; i < 800; i++) txPut(tx, 'attempts', String(i), { credential: credential.id, at: now, outcome: 'reserved' }); });
    const scheduler = new Scheduler(repo, async () => credential);
    expect(await scheduler.reserve(credential, false, false, now)).toMatchObject({ blocked: 'budget' });
    expect(await scheduler.reserve(credential, true, false, now)).toHaveProperty('id');
    expect((await new Scheduler(repo, async () => credential).status()).count).toBe(801);
  });
  it('retains accounting and cooldown across rating cache clears and credential versions', async () => {
    const scheduler = new Scheduler(repo, async () => credential); await scheduler.reserve(credential, true);
    await repo.put('state', `provider:${credential.id}`, { kind: 'quota', until: Date.now() + 100000, failures: 0, quotaStep: 1 });
    await repo.put('ratings', ratingKey(record().subject), record()); await repo.clear('ratings');
    expect((await scheduler.status()).count).toBe(1);
    expect(await scheduler.reserve({ ...credential, version: 2 }, true)).toMatchObject({ blocked: 'quota' });
  });
  it('does not dispatch without a durably persisted reservation', async () => {
    const broken = new Repository(`broken-${crypto.randomUUID()}`); vi.spyOn(broken, 'transaction').mockRejectedValue(new Error('disk full'));
    const fetcher = vi.fn(); const scheduler = new Scheduler(broken, async () => credential, fetcher);
    await expect(scheduler.request({ i: raw.imdbID }, true, value => value)).rejects.toThrow('disk full');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('pauses allowance expiry when the clock moves backwards', async () => {
    await repo.put('state', 'lastClock', Date.now() + 3600000);
    expect(await new Scheduler(repo, async () => credential).reserve(credential, true)).toMatchObject({ blocked: 'clock' });
  });
});

describe('resolution correctness and stale jobs', () => {
  function setup(request = vi.fn()) {
    const config = { settings: async () => ({ ...DEFAULT_SETTINGS }), credential: async () => credential } as unknown as Configuration;
    return { request, resolver: new Resolver(repo, { request } as unknown as Scheduler, config) };
  }
  it('does not call the provider for title-only observations', async () => {
    const { request, resolver } = setup();
    expect((await resolver.lookup({ ...observation, year: undefined })).state).toMatchObject({ kind: 'needs_match' });
    expect(request).not.toHaveBeenCalled();
  });
  it('reuses monthly cached details for previews but still sends a deliberate key test', async () => {
    const cached = { ...record(), fetchedAt: Date.now() - 20 * 86400000 };
    await repo.put('ratings', ratingKey(cached.subject), cached);
    const request = vi.fn().mockResolvedValue(record());
    const { resolver } = setup(request);
    expect((await resolver.detail(raw.imdbID, true)).fetchedAt).toBe(cached.fetchedAt);
    expect(request).not.toHaveBeenCalled();
    await resolver.detail(raw.imdbID, true, true);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('accepts a single complete supported candidate and returns a committed revision', async () => {
    const request = vi.fn().mockImplementationOnce(async (_p, _e, decode) => decode({ Response: 'True', totalResults: '1', Search: [{ ...raw }] }))
      .mockImplementationOnce(async (_p, _e, decode) => decode(raw));
    const { resolver } = setup(request);
    expect(await resolver.lookup(observation)).toMatchObject({ revision: 1, state: { kind: 'rated', record: { score: 8.2 } } });
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.revision).toBe(1);
  });
  it('never accepts a truncated candidate set', async () => {
    const request = vi.fn(async (_p, _e, decode) => decode({ Response: 'True', totalResults: '11', Search: [{ ...raw }] }));
    expect((await setup(request).resolver.lookup(observation)).state).toMatchObject({ kind: 'needs_match', reason: 'ambiguous' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not keep transient deferrals as six-hour title misses', async () => {
    const request = vi.fn().mockRejectedValueOnce(new DeferredError('busy', 'busy'))
      .mockImplementationOnce(async (_p, _e, decode) => decode({ Response: 'True', totalResults: '1', Search: [{ ...raw }] }))
      .mockImplementationOnce(async (_p, _e, decode) => decode(raw));
    const { resolver } = setup(request);
    expect((await resolver.lookup(observation)).state.kind).toBe('deferred');
    expect((await resolver.lookup(observation)).state.kind).toBe('rated');
  });
  it('cannot recreate a previously unmapped title after reset during its lookup', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn().mockImplementationOnce(async (_p, _e, decode) => { await blocked; return decode({ Response: 'True', totalResults: '1', Search: [{ ...raw }] }); })
      .mockImplementationOnce(async (_p, _e, decode) => decode(raw));
    const { resolver } = setup(request); const result = resolver.lookup(observation);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    const secondConsumer = resolver.lookup(observation);
    await new Promise(resolve => setTimeout(resolve, 10));
    await repo.put('state', 'mappingEpoch', 1); release();
    expect((await result).state.kind).toBe('needs_match');
    expect((await secondConsumer).state.kind).toBe('needs_match');
    expect(await repo.get('mappings', titleKey(observation.ref))).toBeUndefined();
  });
  it('cannot overwrite a manual correction made during an automatic lookup', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn().mockImplementationOnce(async (_p, _e, decode) => { await blocked; return decode({ Response: 'True', totalResults: '1', Search: [{ ...raw }] }); })
      .mockImplementationOnce(async (_p, _e, decode) => decode(raw));
    const { resolver } = setup(request); const result = resolver.lookup(observation);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await repo.put('mappings', titleKey(observation.ref), { ref: observation.ref, subject: { namespace: 'imdb', id: 'tt7654321' }, evidence: observation, method: 'manual', revision: 1, rejected: [], resolverVersion: 1 } satisfies Mapping);
    release(); await result;
    expect((await repo.get<Mapping>('mappings', titleKey(observation.ref)))?.subject?.id).toBe('tt7654321');
  });
  it('hides an older movie score beyond its monthly window and stale grace when requests fail', async () => {
    await repo.put('mappings', titleKey(observation.ref), { ref: observation.ref, subject: record().subject, evidence: observation, method: 'manual', revision: 1, rejected: [], resolverVersion: 1 } satisfies Mapping);
    await repo.put('ratings', ratingKey(record().subject), { ...record(), fetchedAt: Date.now() - 38 * 86400000 });
    expect((await setup(vi.fn().mockRejectedValue(new DeferredError('offline', 'offline'))).resolver.lookup(observation)).state.kind).toBe('deferred');
  });
});
