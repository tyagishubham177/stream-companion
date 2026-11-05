import { PROTOCOL_VERSION, RESOLVER_VERSION, titleKey, type AppStatus, type Broadcast, type CorrectionContext, type LookupResult, type Mapping, type PlatformTitleRef, type PublicStatus, type RatingRecord, type SavedMatch } from '../shared/contracts';
import { authoriseCommand, authoriseSender, validateRequest } from '../shared/validation';
import { contradicts, observationFingerprint, parseImdbInput } from '../shared/identity';
import { parseSearch, ProviderError } from '../providers/omdb';
import { Configuration } from './config';
import { Repository, idbRequest, txGet, txPut } from './repository';
import { DeferredError, Scheduler } from './scheduler';
import { Resolver, stateFromRecord } from './resolver';
import { WikidataResolver } from '../providers/wikidata';
import { NetflixMetadataResolver } from '../providers/netflix-metadata';

const repo = new Repository();
const config = new Configuration();
const scheduler = new Scheduler(repo, () => config.credential(), fetch, () => config.settings());
const directIds = new WikidataResolver(repo, () => config.settings());
const metadata = new NetflixMetadataResolver(repo, () => config.settings());
const resolver = new Resolver(repo, scheduler, config, directIds, metadata);
const ready = Promise.all([config.ready(), repo.open()]);
// Prevent a rejected startup promise becoming an unhandled rejection before the first message.
void ready.catch(() => undefined);
interface StoredContext extends CorrectionContext {
  expiresAt: number;
  resetEpoch: number;
  preview?: { id: string; record: RatingRecord; expiresAt: number };
}
interface Client { tabId: number; documentId: string }
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
function liveDemand(sender: chrome.runtime.MessageSender, ref: PlatformTitleRef): () => boolean {
  const documentId = sender.documentId!;
  const entries = demands.get(documentId) ?? new Map(); demands.set(documentId, entries);
  const key = titleKey(ref);
  const token = entries.get(key) ?? { active: true, at: Date.now() };
  token.active = true; token.at = Date.now(); entries.set(key, token);
  return () => token.active && Date.now() - token.at < 30000;
}
function releaseDemand(documentId: string, ref?: PlatformTitleRef): void {
  const entries = demands.get(documentId); if (!entries) return;
  if (ref) { const token = entries.get(titleKey(ref)); if (token) token.active = false; entries.delete(titleKey(ref)); }
  else { for (const token of entries.values()) token.active = false; demands.delete(documentId); }
}

async function register(sender: chrome.runtime.MessageSender): Promise<void> {
  if (sender.tab?.id === undefined || !sender.documentId) return;
  // Documents are ephemeral routing metadata, never a record of titles or full URLs.
  const documentId = sender.documentId; const tabId = sender.tab.id;
  await mutateClients(clients => { clients[documentId] = { tabId, documentId }; });
}
async function broadcast(message: Broadcast): Promise<void> {
  const { clients = {} } = await chrome.storage.session.get('clients') as { clients?: Record<string, Client> };
  const failed: string[] = [];
  await Promise.all(Object.values(clients).map(async client => {
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
  return { ...pub, requests24h: usage.count, automaticLimit: 800, totalLimit: 900, mappings: mappings.filter(x => x.value.subject).length, ratings: ratings.length };
}
async function context(id: string): Promise<StoredContext> {
  const value = await repo.get<StoredContext>('contexts', id);
  if (!value || value.expiresAt < Date.now()) throw new Error('This correction session expired. Open Match title again from Netflix.');
  return value;
}
async function saveMatch(ctx: StoredContext, record: RatingRecord): Promise<LookupResult> {
  const revision = await repo.transaction(['mappings', 'contexts', 'state'], async tx => {
    const current = await txGet<Mapping>(tx, 'mappings', titleKey(ctx.observation.ref));
    if ((current?.revision ?? 0) !== ctx.revision || (await txGet<number>(tx, 'state', 'mappingEpoch') ?? 0) !== ctx.resetEpoch) throw new Error('The match changed in another page. Reopen Match title from Netflix.');
    const revision = (current?.revision ?? 0) + 1;
    const rejected = new Set(current?.rejected ?? []);
    if (current?.subject && current.subject.id !== record.subject.id) rejected.add(current.subject.id);
    rejected.delete(record.subject.id);
    txPut(tx, 'mappings', titleKey(ctx.observation.ref), { ref: ctx.observation.ref, subject: record.subject, evidence: ctx.observation,
      revision, method: 'manual', rejected: [...rejected], resolverVersion: RESOLVER_VERSION } satisfies Mapping);
    tx.objectStore('contexts').delete(ctx.id);
    return revision;
  }, true);
  await broadcast({ type: 'SC_INVALIDATE', ref: ctx.observation.ref, revision });
  return { state: stateFromRecord(record, 'manual'), fingerprint: observationFingerprint(ctx.observation), revision };
}
async function removeMatch(ref: PlatformTitleRef, expectedRevision: number): Promise<void> {
  const revision = await repo.transaction(['mappings'], async tx => {
    const old = await txGet<Mapping>(tx, 'mappings', titleKey(ref));
    if (!old || old.revision !== expectedRevision) throw new Error('The saved match changed. Reload saved matches and try again.');
    const revision = old.revision + 1;
    // Keep a tombstone and rejected candidate so stale automatic work cannot recreate a removed match.
    txPut(tx, 'mappings', titleKey(ref), { ...old, subject: undefined, revision,
      rejected: [...new Set([...old.rejected, ...(old.subject ? [old.subject.id] : [])])] });
    return revision;
  }, true);
  await broadcast({ type: 'SC_INVALIDATE', ref, revision });
}

async function route(raw: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const request = validateRequest(raw);
  const role = authoriseSender(sender, chrome.runtime.id, request.type);
  authoriseCommand(role, request.type);
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
      try { await repo.prune(Date.now()); maintenanceFailed = false; }
      catch { maintenanceFailed = true; }
      for (const [documentId, entries] of demands) {
        for (const [key, token] of entries) if (Date.now() - token.at > 30000) { token.active = false; entries.delete(key); }
        if (!entries.size) demands.delete(documentId);
      }
      for (const [key, value] of navigationRates) if (Date.now() - value.at > 60000) navigationRates.delete(key);
    }
    if (role === 'content') await register(sender);
    switch (request.type) {
      case 'GET_PUBLIC_STATUS': return await publicStatus();
      case 'GET_STATUS': return await status();
      case 'OPEN_SETTINGS': await chrome.runtime.openOptionsPage(); return null;
      case 'LOOKUP': return await resolver.lookup(request.observation, false, undefined, liveDemand(sender, request.observation.ref));
      case 'RELEASE_DEMAND': releaseDemand(sender.documentId!, request.ref); return null;
      case 'REFRESH': return await resolver.lookup(request.observation, true, request.revision);
      case 'UPDATE_SETTINGS': await config.update(request.settings); await broadcast({ type: 'SC_INVALIDATE' }); return null;
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
        await repo.put('contexts', id, { id, observation: request.observation, revision: request.revision, resetEpoch: await repo.get<number>('state', 'mappingEpoch') ?? 0, expiresAt: Date.now() + 1800000 } satisfies StoredContext);
        await chrome.tabs.create({ url: chrome.runtime.getURL(`correction.html?context=${id}`) });
        return { contextId: id };
      }
      case 'GET_CONTEXT': {
        const ctx = await context(request.contextId);
        return { id: ctx.id, observation: ctx.observation, revision: ctx.revision } satisfies CorrectionContext;
      }
      case 'SEARCH_MATCHES': {
        await context(request.contextId);
        try { return await scheduler.request({ s: request.query.trim(), page: String(request.page) }, true, raw => parseSearch(raw, request.page)); }
        catch (error) { if (error instanceof ProviderError && error.kind === 'not_found') return { candidates: [], total: 0, page: request.page }; throw error; }
      }
      case 'PREVIEW_MATCH': {
        const ctx = await context(request.contextId);
        const id = parseImdbInput(request.input); if (!id) throw new Error('Use a valid IMDb tt ID or an https://www.imdb.com/title/ URL.');
        const record = await resolver.detail(id, true);
        if (contradicts(ctx.observation, record)) throw new Error('This title conflicts with the observed year or movie/series type. Select the matching work.');
        const previewId = crypto.randomUUID();
        await repo.put('contexts', ctx.id, { ...ctx, preview: { id: previewId, record, expiresAt: Date.now() + 600000 } });
        return { previewId, record };
      }
      case 'CONFIRM_MATCH': {
        const ctx = await context(request.contextId);
        if (!ctx.preview || ctx.preview.id !== request.previewId || ctx.preview.expiresAt < Date.now()) throw new Error('Preview the title again before saving the match.');
        return await saveMatch(ctx, ctx.preview.record);
      }
      case 'LIST_MATCHES': return (await repo.all<Mapping>('mappings')).filter(x => x.value.subject).map(x => ({ ref: x.value.ref, displayTitle: x.value.evidence.displayTitle,
        imdbId: x.value.subject!.id, revision: x.value.revision } satisfies SavedMatch));
      case 'REMOVE_MATCH': await removeMatch(request.ref, request.revision); return null;
      case 'RESET_MATCHES': {
        await repo.transaction(['mappings', 'state'], async tx => {
          txPut(tx, 'state', 'mappingEpoch', (await txGet<number>(tx, 'state', 'mappingEpoch') ?? 0) + 1);
          const all = await idbRequest(tx.objectStore('mappings').getAll()) as Array<{ key: string; value: Mapping }>;
          for (const { key, value } of all) txPut(tx, 'mappings', key, { ...value, subject: undefined, rejected: [], revision: value.revision + 1 });
        }, true);
        await broadcast({ type: 'SC_INVALIDATE' }); return null;
      }
      case 'CLEAR_RATING_CACHE': await repo.clear('ratings'); await broadcast({ type: 'SC_INVALIDATE' }); return null;
      case 'EXPORT_DIAGNOSTICS': {
        const app = await status();
        return { product: 'Stream Companion', version: chrome.runtime.getManifest().version, protocol: PROTOCOL_VERSION,
          generatedAt: new Date().toISOString(), enabled: app.settings.enabled, cacheOnly: app.settings.cacheOnly,
          keyConfigured: app.keyConfigured, providerState: app.provider.kind, requests24h: app.requests24h,
          mappings: app.mappings, ratings: app.ratings, maintenanceFailed, platforms: ['netflix'], features: ['ratings'], identityProvider: 'wikidata', metadataProvider: 'netflix-public' };
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
    const message = error instanceof ProviderError || error instanceof DeferredError ? error.message :
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
void ready.then(() => repo.prune(Date.now())).catch(() => { maintenanceFailed = true; });
