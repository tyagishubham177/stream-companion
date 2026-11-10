import { PROTOCOL_VERSION, RESOLVER_VERSION, titleKey, type AppStatus, type Broadcast, type CorrectionContext, type LookupResult, type Mapping, type PlatformTitleRef, type PublicStatus, type RatingRecord, type SavedMatch, type SearchResult } from '../shared/contracts';
import { authoriseRequest, validateRequest } from '../shared/validation';
import { contradicts, observationFingerprint, parseImdbInput } from '../shared/identity';
import { parseSearch, ProviderError } from '../providers/omdb';
import { Configuration } from './config';
import { Repository, idbRequest, txGet, txPut } from './repository';
import { DeferredError, Scheduler } from './scheduler';
import { Resolver, candidateChecks, stateFromRecord } from './resolver';
import { WikidataResolver } from '../providers/wikidata';
import { NetflixMetadataResolver } from '../providers/netflix-metadata';
import { MarksService, MarkError } from './marks';
import { HotstarPosterMemory } from './hotstar-posters';
import { clearRatingCache, HotstarPosterRatings } from './hotstar-poster-ratings';
import { MatchingLog, candidateRecord, type AutomaticDecision, type MatchEvent, type SearchEvidence, type SearchSelection } from './matching-log';

const repo = new Repository();
const config = new Configuration();
const marks = new MarksService(repo);
const hotstarPosters = new HotstarPosterMemory();
const scheduler = new Scheduler(repo, () => config.credential(), fetch, async () => { const s = await config.settings(); return { ...s, enabled: s.enabled && s.ratingsEnabled !== false }; });
const hotstarPosterRatings = new HotstarPosterRatings(repo, scheduler, config);
const matchingEligibility = async () => { const s = await config.settings(); return { ...s, enabled: s.enabled && s.ratingsEnabled !== false && s.automaticMatching !== false }; };
const directIds = new WikidataResolver(repo, matchingEligibility);
const metadata = new NetflixMetadataResolver(repo, matchingEligibility);
const matchingLog = new MatchingLog(repo, chrome.runtime.getManifest().version);
const resolver = new Resolver(repo, scheduler, config, directIds, metadata, matchingLog);
const ready = Promise.all([config.ready(), repo.open()]).then(async () => { matchingLog.recording = (await config.settings()).matchingLogEnabled !== false; });
// Prevent a rejected startup promise becoming an unhandled rejection before the first message.
void ready.catch(() => undefined);
interface StoredContext extends CorrectionContext {
  expiresAt: number;
  resetEpoch: number;
  logEpoch?: number;
  automatic?: AutomaticDecision;
  searches?: Array<SearchEvidence & { id: string }>;
  preview?: { id: string; record: RatingRecord; expiresAt: number; selection?: SearchSelection };
}
interface Client { tabId: number; documentId: string; platformId?: string }
const rates = new Map<string, { since: number; count: number; active: number }>();
let actionsSincePrune = 0;
let maintenanceFailed = false;
const demands = new Map<string, Map<string, { active: boolean; at: number }>>();
const navigationRates = new Map<string, { at: number; count: number }>();
let clientMutations: Promise<void> = Promise.resolve();
function mutateClients(work: (clients: Record<string, Client>) => void): Promise<void> {
  const result = clientMutations.then(async () => {
    const { clients = {} } = await chrome.storage.session.get('clients') as { clients?: Record<string, Client> };
    work(clients);
    await chrome.storage.session.set({ clients: Object.fromEntries(Object.entries(clients).slice(-100)) });
  });
  clientMutations = result.catch(() => undefined); // Each caller observes its own failure.
  return result;
}
const posterDemandKey = (key: string) => JSON.stringify(['hotstar-poster', key]);
function liveDemand(sender: chrome.runtime.MessageSender, key: string): () => boolean {
  const documentId = sender.documentId!;
  const entries = demands.get(documentId) ?? new Map(); demands.set(documentId, entries);
  const token = entries.get(key) ?? { active: true, at: Date.now() };
  token.active = true; token.at = Date.now(); entries.set(key, token);
  return () => token.active && Date.now() - token.at < 30000;
}
function releaseDemand(documentId: string, key?: string): void {
  const entries = demands.get(documentId); if (!entries) return;
  if (key) { const token = entries.get(key); if (token) token.active = false; entries.delete(key); }
  else { for (const token of entries.values()) token.active = false; demands.delete(documentId); }
}

async function register(sender: chrome.runtime.MessageSender, platformId: string): Promise<void> {
  if (sender.tab?.id === undefined || !sender.documentId) return;
  // Documents are ephemeral routing metadata, never a record of titles or full URLs.
  const documentId = sender.documentId; const tabId = sender.tab.id;
  await mutateClients(clients => { clients[documentId] = { tabId, documentId, platformId }; });
}
async function broadcast(message: Broadcast): Promise<void> {
  if (message.type === 'SC_MARKS_CHANGED') {
    // Runtime messages reach trusted extension pages; tab messages reach content scripts.
    try { await chrome.runtime.sendMessage(message); }
    catch (error) {
      const detail = error instanceof Error ? error.message : '';
      if (!/Receiving end does not exist|message port closed|port closed before|Could not establish connection/i.test(detail))
        console.warn('[Stream Companion] Saved marks could not be broadcast to extension pages. Reopen Your titles to refresh.');
    }
  }
  const { clients = {} } = await chrome.storage.session.get('clients') as { clients?: Record<string, Client> };
  const targets = Object.values(clients).filter(client => !message.ref || (client.platformId ?? 'netflix') === message.ref.platformId);
  const failed: string[] = [];
  await Promise.all(targets.map(async client => {
    try { await chrome.tabs.sendMessage(client.tabId, message, { documentId: client.documentId }); }
    catch { failed.push(client.documentId); }
  }));
  if (failed.length) {
    await mutateClients(latest => { for (const id of failed) { delete latest[id]; releaseDemand(id); } });
  }
}
async function publicStatus(): Promise<PublicStatus> {
  const credential = await config.credential(); const settings = await config.settings();
  const { count, circuit } = await scheduler.status();
  let provider: PublicStatus['provider'] = credential ? { kind: 'ready', message: 'OMDb key configured. Requests are checked when sent.' } : { kind: 'setup', message: 'Add your OMDb key to fetch ratings.' };
  if (circuit?.kind) provider = { kind: 'paused', message: circuit.kind === 'key' ? 'OMDb rejected the key. Check or retest it in Settings.' : circuit.kind === 'quota' ? 'OMDb request limit reached. Cached ratings remain available.' : 'The rating service is cooling down.', retryAfter: circuit.kind === 'key' ? undefined : circuit.until };
  if (count >= 900) provider = { kind: 'paused', message: 'The local request allowance is used up.' };
  else if (count >= 800 && !circuit?.kind) provider = { kind: 'paused', message: 'Automatic lookups paused; the remaining allowance is reserved for your actions.' };
  if (maintenanceFailed) provider = { kind: 'paused', message: 'Local cache maintenance failed. Reload the extension or check available browser storage.' };
  return { settings, keyConfigured: !!credential, provider };
}
async function status(): Promise<AppStatus> {
  const [pub, usage, mappings, ratings] = await Promise.all([publicStatus(), scheduler.status(), repo.all<Mapping>('mappings'), repo.all('ratings')]);
  return { ...pub, requests24h: usage.count, automaticLimit: 800, totalLimit: 900, mappings: mappings.filter(x => x.value.subject).length, ratings: ratings.length, matchingLogFailed: matchingLog.failed };
}
async function context(id: string): Promise<StoredContext> {
  const value = await repo.get<StoredContext>('contexts', id);
  if (!value || value.expiresAt < Date.now()) throw new Error('This correction session expired. Open Match title again from the streaming page.');
  return value;
}
function correctionEvent(ctx: StoredContext, kind: MatchEvent['kind'], data: Parameters<MatchingLog['event']>[4] = {}): MatchEvent {
  return matchingLog.event(kind, ctx.observation, ctx.revision, ctx.resetEpoch, { sessionId: ctx.id, ...data }, ctx.logEpoch ?? 0);
}
async function logFailure(ctx: StoredContext, stage: string, error: unknown): Promise<void> {
  const reason = error instanceof ProviderError ? error.kind : error instanceof DeferredError ? error.reason : 'storage_or_validation';
  try { await matchingLog.append(correctionEvent(ctx, 'failure', { reason: `${stage}:${reason}` })); }
  catch { matchingLog.failed = true; }
}
async function saveMatch(ctx: StoredContext, record: RatingRecord): Promise<LookupResult> {
  const revision = await repo.transaction(['mappings', 'contexts', 'state', 'matchingLogs'], async tx => {
    const current = await txGet<Mapping>(tx, 'mappings', titleKey(ctx.observation.ref));
    const live = await txGet<StoredContext>(tx, 'contexts', ctx.id);
    if (!live || live.expiresAt < Date.now() || !live.preview || live.preview.id !== ctx.preview?.id || live.preview.expiresAt < Date.now())
      throw new Error('Preview the title again before saving the match.');
    if ((current?.revision ?? 0) !== ctx.revision || (await txGet<number>(tx, 'state', 'mappingEpoch') ?? 0) !== ctx.resetEpoch) throw new Error('The match changed in another page. Reopen Match title from the streaming page.');
    const revision = (current?.revision ?? 0) + 1;
    const rejected = new Set(current?.rejected ?? []);
    if (current?.subject && current.subject.id !== record.subject.id) rejected.add(current.subject.id);
    rejected.delete(record.subject.id);
    txPut(tx, 'mappings', titleKey(ctx.observation.ref), { ref: ctx.observation.ref, subject: record.subject, evidence: ctx.observation,
      revision, method: 'manual', rejected: [...rejected], resolverVersion: RESOLVER_VERSION } satisfies Mapping);
    const steps = [...(ctx.automatic?.steps ?? [])].reverse();
    const evidence = steps.find(step => step.stage === 'enriched_evidence')?.evidence ?? ctx.observation;
    const automaticSearch = steps.find(step => step.search?.candidates.some(candidate => candidate.id === record.subject.id))?.search;
    const automaticRank = automaticSearch ? (automaticSearch.page - 1) * 10 + automaticSearch.candidates.findIndex(candidate => candidate.id === record.subject.id) + 1 : undefined;
    const logged = await matchingLog.appendInTransaction(tx, correctionEvent(ctx, 'confirmed', {
      candidate: candidateRecord(record), selection: live.preview.selection, automatic: ctx.automatic,
      previousImdbId: current?.subject?.id,
      comparison: { evidence, checks: candidateChecks(evidence, candidateRecord(record), current?.rejected ?? []),
        returnedByAutomaticSearch: !!automaticSearch, automaticRank },
    }));
    if (!logged) throw new Error('This correction session expired. Open Match title again from the streaming page.');
    tx.objectStore('contexts').delete(ctx.id);
    return revision;
  }, true);
  matchingLog.failed = false;
  await broadcast({ type: 'SC_INVALIDATE', ref: ctx.observation.ref, revision });
  return { state: stateFromRecord(record, 'manual'), fingerprint: observationFingerprint(ctx.observation), revision };
}
async function removeMatch(ref: PlatformTitleRef, expectedRevision: number): Promise<void> {
  const revision = await repo.transaction(['mappings', 'matchingLogs', 'state'], async tx => {
    const old = await txGet<Mapping>(tx, 'mappings', titleKey(ref));
    if (!old || old.revision !== expectedRevision) throw new Error('The saved match changed. Reload saved matches and try again.');
    const revision = old.revision + 1;
    // Keep a tombstone and rejected candidate so stale automatic work cannot recreate a removed match.
    txPut(tx, 'mappings', titleKey(ref), { ...old, subject: undefined, revision,
      rejected: [...new Set([...old.rejected, ...(old.subject ? [old.subject.id] : [])])] });
    await matchingLog.appendInTransaction(tx, matchingLog.event('removed', old.evidence, old.revision,
      await txGet<number>(tx, 'state', 'mappingEpoch') ?? 0, { previousImdbId: old.subject?.id },
      await txGet<number>(tx, 'state', 'matchingLogEpoch') ?? 0));
    return revision;
  }, true);
  await broadcast({ type: 'SC_INVALIDATE', ref, revision });
}

async function route(raw: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const request = validateRequest(raw);
  const authority = authoriseRequest(sender, chrome.runtime.id, request);
  const { role } = authority;
  const rateKey = sender.documentId ?? `${role}:${sender.url?.split('?')[0]}`;
  const now = Date.now();
  let rate = rates.get(rateKey);
  if (!rate || now - rate.since > 60000) { rate = { since: now, count: 0, active: 0 }; rates.set(rateKey, rate); }
  if (++rate.count > 240 || rate.active >= 40) throw new Error('Too many extension requests. Try again shortly.');
  if (role === 'content' && ['OPEN_SETTINGS', 'OPEN_CORRECTION'].includes(request.type)) {
    let navigation = navigationRates.get(rateKey);
    if (!navigation || now - navigation.at > 60000) { navigation = { at: now, count: 0 }; navigationRates.set(rateKey, navigation); }
    if (++navigation.count > 10) throw new Error('Too many new extension pages. Try again in a minute.');
  }
  rate.active++;
  try {
    await ready;
    if (++actionsSincePrune >= 100) {
      actionsSincePrune = 0;
      try { await repo.prune(Date.now()); await matchingLog.maintain(); maintenanceFailed = false; }
      catch { maintenanceFailed = true; }
      for (const [documentId, entries] of demands) {
        for (const [key, token] of entries) if (Date.now() - token.at > 30000) { token.active = false; entries.delete(key); }
        if (!entries.size) demands.delete(documentId);
      }
      for (const [key, value] of navigationRates) if (Date.now() - value.at > 60000) navigationRates.delete(key);
    }
    if (role === 'content' && request.type !== 'GET_HOTSTAR_POSTERS' && request.type !== 'SAVE_HOTSTAR_POSTERS')
      await register(sender, authority.platformId);
    switch (request.type) {
      case 'GET_HOTSTAR_POSTERS': return await hotstarPosters.get();
      case 'SAVE_HOTSTAR_POSTERS': return await hotstarPosters.save(request.entries);
      case 'LOOKUP_HOTSTAR_POSTER_RATING':
        return await hotstarPosterRatings.lookup(request.poster, liveDemand(sender, posterDemandKey(request.poster.key)));
      case 'GET_PUBLIC_STATUS': return await publicStatus();
      case 'GET_STATUS': return await status();
      case 'GET_MARKS': return await marks.get(request.refs);
      case 'LIST_MARKS': return await marks.list();
      case 'SET_MARK': {
        const settings = await config.settings();
        if (role === 'content' && (!settings.enabled || !settings.marksEnabled)) throw new MarkError('Title marks are disabled. Enable them in Settings.');
        const result = await marks.set(request.observation, { ...('watched' in request ? { watched: request.watched } : {}), ...('plan' in request ? { plan: request.plan } : {}) }, request.revision, request.epoch);
        await broadcast({ type: 'SC_MARKS_CHANGED', ref: request.observation.ref }); return result;
      }
      case 'UNDO_MARK': {
        const result = await marks.undo(request.ref, request.operationId, request.revision, request.epoch);
        await broadcast({ type: 'SC_MARKS_CHANGED', ref: request.ref }); return result;
      }
      case 'RESET_MARKS': await marks.reset(); await broadcast({ type: 'SC_MARKS_CHANGED' }); return null;
      case 'EXPORT_MARKS': return { product: 'Stream Companion', format: 1, generatedAt: new Date().toISOString(), ...(await marks.export()) };
      case 'OPEN_TITLES': await chrome.tabs.create({ url: chrome.runtime.getURL('titles.html') }); return null;
      case 'OPEN_SETTINGS': await chrome.runtime.openOptionsPage(); return null;
      case 'LOOKUP': return await resolver.lookup(request.observation, false, undefined, liveDemand(sender, titleKey(request.observation.ref)));
      case 'RELEASE_DEMAND': {
        const key = request.posterKey ? posterDemandKey(request.posterKey) : request.ref ? titleKey(request.ref) : undefined;
        releaseDemand(sender.documentId!, key); return null;
      }
      case 'REFRESH': return await resolver.lookup(request.observation, true, request.revision);
      case 'UPDATE_SETTINGS': await config.update(request.settings); matchingLog.recording = (await config.settings()).matchingLogEnabled !== false; await broadcast({ type: 'SC_INVALIDATE' }); return null;
      case 'SET_API_KEY': await config.setKey(request.key.trim()); await broadcast({ type: 'SC_INVALIDATE' }); return null;
      case 'REMOVE_API_KEY': await config.setKey(''); await broadcast({ type: 'SC_INVALIDATE' }); return null;
      case 'TEST_API_KEY': {
        // Known IMDb reference ID; this is one real, accounted provider request.
        await resolver.detail('tt0133093', true, true);
        await broadcast({ type: 'SC_INVALIDATE' }); return { valid: true };
      }
      case 'OPEN_CORRECTION': {
        const current = await repo.get<Mapping>('mappings', titleKey(request.observation.ref));
        if ((current?.revision ?? 0) !== request.revision) throw new Error('The match changed. Reopen the title details.');
        const id = crypto.randomUUID();
        const resetEpoch = await repo.get<number>('state', 'mappingEpoch') ?? 0;
        const logEpoch = await matchingLog.generation();
        const automatic = await matchingLog.latest(request.observation, request.revision, resetEpoch);
        const ctx: StoredContext = { id, observation: request.observation, revision: request.revision, resetEpoch, logEpoch, automatic, expiresAt: Date.now() + 1800000 };
        await repo.transaction(['contexts', 'matchingLogs', 'state'], async tx => {
          if ((await txGet<number>(tx, 'state', 'matchingLogEpoch') ?? 0) !== ctx.logEpoch) throw new Error('This correction session expired. Open Match title again from the streaming page.');
          txPut(tx, 'contexts', id, ctx);
          await matchingLog.appendInTransaction(tx, correctionEvent(ctx, 'opened', { automatic }));
        });
        matchingLog.failed = false;
        await chrome.tabs.create({ url: chrome.runtime.getURL(`correction.html?context=${id}`) });
        return { contextId: id };
      }
      case 'GET_CONTEXT': {
        const ctx = await context(request.contextId);
        return { id: ctx.id, observation: ctx.observation, revision: ctx.revision } satisfies CorrectionContext;
      }
      case 'SEARCH_MATCHES': {
        const ctx = await context(request.contextId);
        try {
          let result: SearchResult;
          try { result = await scheduler.request({ s: request.query.trim(), page: String(request.page) }, true, raw => parseSearch(raw, request.page)); }
          catch (error) { if (error instanceof ProviderError && error.kind === 'not_found') result = { candidates: [], total: 0, page: request.page }; else throw error; }
          const search = { ...result, query: request.query.trim(), id: crypto.randomUUID() };
          await repo.transaction(['contexts', 'matchingLogs', 'state'], async tx => {
            const live = await txGet<StoredContext>(tx, 'contexts', ctx.id);
            if (!live || live.expiresAt < Date.now()) throw new Error('This correction session expired. Open Match title again from the streaming page.');
            txPut(tx, 'contexts', ctx.id, { ...live, searches: [...(live.searches ?? []), search].slice(-10) });
            await matchingLog.appendInTransaction(tx, correctionEvent(ctx, 'search', { search }));
          });
          matchingLog.failed = false;
          return { ...result, searchId: search.id };
        } catch (error) { await logFailure(ctx, 'search', error); throw error; }
      }
      case 'PREVIEW_MATCH': {
        const ctx = await context(request.contextId);
        try {
          const id = parseImdbInput(request.input); if (!id) throw new Error('Use a valid IMDb tt ID or an https://www.imdb.com/title/ URL.');
          let selection: SearchSelection | undefined;
          if (request.searchId) {
            const search = ctx.searches?.find(search => search.id === request.searchId);
            const position = search?.candidates.findIndex(candidate => candidate.id === id) ?? -1;
            if (!search || position < 0) throw new Error('Invalid search reference. Search again before previewing this result.');
            selection = { searchId: search.id, query: search.query, page: search.page, position: position + 1,
              rank: (search.page - 1) * 10 + position + 1, total: search.total };
          }
          const record = await resolver.detail(id, true);
          if (contradicts(ctx.observation, record)) {
            await matchingLog.append(correctionEvent(ctx, 'failure', { reason: 'preview:year_or_type_contradiction', candidate: candidateRecord(record), selection }));
            throw new Error('This title conflicts with the observed year or movie/series type. Select the matching work.');
          }
          const previewId = crypto.randomUUID();
          await repo.transaction(['contexts', 'matchingLogs', 'state'], async tx => {
            const live = await txGet<StoredContext>(tx, 'contexts', ctx.id);
            if (!live || live.expiresAt < Date.now()) throw new Error('This correction session expired. Open Match title again from the streaming page.');
            txPut(tx, 'contexts', ctx.id, { ...live, preview: { id: previewId, record, selection, expiresAt: Date.now() + 600000 } });
            await matchingLog.appendInTransaction(tx, correctionEvent(ctx, 'preview', { candidate: candidateRecord(record), selection }));
          });
          matchingLog.failed = false;
          return { previewId, record };
        } catch (error) { await logFailure(ctx, 'preview', error); throw error; }
      }
      case 'CONFIRM_MATCH': {
        const ctx = await context(request.contextId);
        try {
          if (!ctx.preview || ctx.preview.id !== request.previewId || ctx.preview.expiresAt < Date.now()) throw new Error('Preview the title again before saving the match.');
          return await saveMatch(ctx, ctx.preview.record);
        } catch (error) { await logFailure(ctx, 'confirmation', error); throw error; }
      }
      case 'LIST_MATCHES': return (await repo.all<Mapping>('mappings')).filter(x => x.value.subject).map(x => ({
        ref: x.value.ref, displayTitle: x.value.evidence.displayTitle, imdbId: x.value.subject!.id, revision: x.value.revision,
        ...(x.value.evidence.pagePath ? { pagePath: x.value.evidence.pagePath } : {}),
      } satisfies SavedMatch));
      case 'REMOVE_MATCH': await removeMatch(request.ref, request.revision); return null;
      case 'RESET_MATCHES': {
        await repo.transaction(['mappings', 'state', 'matchingLogs'], async tx => {
          const epoch = await txGet<number>(tx, 'state', 'mappingEpoch') ?? 0;
          const logEpoch = await txGet<number>(tx, 'state', 'matchingLogEpoch') ?? 0;
          txPut(tx, 'state', 'mappingEpoch', epoch + 1);
          const all = await idbRequest(tx.objectStore('mappings').getAll()) as Array<{ key: string; value: Mapping }>;
          for (const { key, value } of all) {
            txPut(tx, 'mappings', key, { ...value, subject: undefined, rejected: [], revision: value.revision + 1 });
            if (value.subject) {
              const event = matchingLog.event('reset', value.evidence, value.revision, epoch, { previousImdbId: value.subject.id }, logEpoch);
              await matchingLog.appendInTransaction(tx, event, event.id, false);
            }
          }
          await matchingLog.maintainInTransaction(tx);
        }, true);
        await broadcast({ type: 'SC_INVALIDATE' }); return null;
      }
      case 'CLEAR_RATING_CACHE': await clearRatingCache(repo); await broadcast({ type: 'SC_INVALIDATE' }); return null;
      case 'CLEAR_MATCHING_LOG': {
        await matchingLog.clear(); return null;
      }
      case 'EXPORT_MATCHING_LOG': {
        const events = await matchingLog.export();
        const confirmed = events.filter(event => event.kind === 'confirmed');
        return { product: 'Stream Companion', version: chrome.runtime.getManifest().version, format: 1,
          generatedAt: new Date().toISOString(), retentionDays: 30, limit: 1000, localOnly: true,
          summary: { events: events.length, confirmed: confirmed.length,
            confirmedSearchResults: confirmed.filter(event => event.selection).length,
            confirmedFirstResults: confirmed.filter(event => event.selection?.rank === 1).length }, events };
      }
      case 'EXPORT_DIAGNOSTICS': {
        const app = await status();
        return { product: 'Stream Companion', version: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION,
          generatedAt: new Date().toISOString(), enabled: app.settings.enabled, cacheOnly: app.settings.cacheOnly,
          keyConfigured: app.keyConfigured, providerState: app.provider.kind, requests24h: app.requests24h,
          mappings: app.mappings, ratings: app.ratings, maintenanceFailed, matchingLogFailed: matchingLog.failed, platforms: ['netflix', 'hotstar'], features: ['ratings', 'marks'], identityProvider: 'wikidata', metadataProvider: 'netflix-public' };
      }
    }
  } finally {
    rate.active--;
    if (rates.size > 200) for (const [key, value] of rates) if (Date.now() - value.since > 60000) rates.delete(key);
  }
}

// Listeners are registered at module evaluation, before asynchronous readiness completes.
chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
  if (!(raw && typeof raw === 'object' && 'protocol' in raw)) return false;
  void route(raw, sender).then(value => respond({ ok: true, value })).catch(error => {
    const message = error instanceof ProviderError || error instanceof DeferredError || error instanceof MarkError ? error.message :
      error instanceof Error && /^(Invalid |Unsupported |Message sender|This page|Enter |The (saved )?match|The match changed|This correction|Preview |Use a valid|This title|Too many|Wait a minute|Close other)/.test(error.message) ? error.message :
        'The extension could not complete this action. Check local storage and try again.';
    respond({ ok: false, error: message });
  });
  return true;
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') void ready.then(() => chrome.runtime.openOptionsPage()).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener(tabId => {
  void ready.then(async () => {
    await mutateClients(clients => { for (const [id, client] of Object.entries(clients)) if (client.tabId === tabId) { delete clients[id]; releaseDemand(id); } });
  }).catch(() => undefined);
});
void ready.then(async () => { await repo.prune(Date.now()); await matchingLog.maintain(); }).catch(() => { maintenanceFailed = true; });
