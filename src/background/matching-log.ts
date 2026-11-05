import { RESOLVER_VERSION, titleKey, type Candidate, type LookupState, type TitleObservation } from '../shared/contracts';
import { observationFingerprint } from '../shared/identity';
import { Repository, idbRequest, txGet, txPut } from './repository';

export const LOG_RETENTION = 30 * 86400000;
export const LOG_LIMIT = 1000;
export interface SearchEvidence {
  query: string; page: number; year?: number; mediaType?: string;
  total: number; candidates: Array<Candidate & { checks?: string[] }>;
}
export interface MatchStep {
  stage: string; outcome: string; evidence?: TitleObservation; search?: SearchEvidence;
  candidate?: Candidate; checks?: string[];
}
export interface AutomaticDecision {
  id: string; at: number; observation: TitleObservation; revision: number; epoch: number;
  resolverVersion: number; outcome: { kind: LookupState['kind']; reason?: string; imdbId?: string };
  steps: MatchStep[];
}
export interface SearchSelection {
  searchId: string; query: string; page: number; position: number; rank: number; total: number;
}
export interface MatchEvent {
  id: string; at: number; version: string; resolverVersion: number;
  logEpoch: number;
  kind: 'automatic' | 'opened' | 'search' | 'preview' | 'confirmed' | 'failure' | 'removed' | 'reset';
  observation: TitleObservation; revision: number; epoch: number; sessionId?: string;
  automatic?: AutomaticDecision; search?: SearchEvidence & { id: string };
  candidate?: Candidate; selection?: SearchSelection; previousImdbId?: string;
  comparison?: { evidence: TitleObservation; checks: string[]; returnedByAutomaticSearch: boolean; automaticRank?: number };
  reason?: string;
}
interface Entry { key: string; value: MatchEvent }
export const candidateRecord = (record: { subject: { id: string }; title: string; year: string; mediaType: 'movie' | 'series' }): Candidate =>
  ({ id: record.subject.id, title: record.title, year: record.year, mediaType: record.mediaType });

// Never pass requests, credentials, raw provider responses, URLs or Error objects here.
export class MatchingLog {
  failed = false;
  constructor(readonly repo: Repository, readonly version: string) {}
  event(kind: MatchEvent['kind'], observation: TitleObservation, revision: number, epoch: number,
    data: Partial<Pick<MatchEvent, 'sessionId' | 'automatic' | 'search' | 'candidate' | 'selection' | 'previousImdbId' | 'comparison' | 'reason'>> = {}, logEpoch = 0): MatchEvent {
    return { id: crypto.randomUUID(), at: Date.now(), version: this.version, resolverVersion: RESOLVER_VERSION,
      kind, observation, revision, epoch, logEpoch, ...data };
  }
  async generation(): Promise<number> { return await this.repo.get<number>('state', 'matchingLogEpoch') ?? 0; }
  async append(event: MatchEvent, key = event.id): Promise<void> {
    const written = await this.repo.transaction(['matchingLogs', 'state'], tx => this.appendInTransaction(tx, event, key));
    if (written) this.failed = false;
  }
  async appendInTransaction(tx: IDBTransaction, event: MatchEvent, key = event.id, prune = true): Promise<boolean> {
    if ((await txGet<number>(tx, 'state', 'matchingLogEpoch') ?? 0) !== event.logEpoch) return false;
    txPut(tx, 'matchingLogs', key, event);
    if (prune) await this.prune(tx, event.at);
    return true;
  }
  private async prune(tx: IDBTransaction, now: number): Promise<void> {
    const entries = await idbRequest(tx.objectStore('matchingLogs').getAll()) as Entry[];
    entries.sort((a, b) => b.value.at - a.value.at);
    // Preserve room for correction history even after browsing a large catalogue.
    let automatic = 0;
    const retained: Entry[] = [];
    for (const entry of entries) {
      if (entry.value.at < now - LOG_RETENTION || (entry.value.kind === 'automatic' && ++automatic > 500))
        tx.objectStore('matchingLogs').delete(entry.key);
      else retained.push(entry);
    }
    for (const entry of retained.slice(LOG_LIMIT)) tx.objectStore('matchingLogs').delete(entry.key);
  }
  private automaticKey(observation: TitleObservation, revision: number, epoch: number): string {
    return JSON.stringify(['automatic', titleKey(observation.ref), observationFingerprint(observation), revision, epoch, RESOLVER_VERSION]);
  }
  async latest(observation: TitleObservation, revision: number, epoch: number): Promise<AutomaticDecision | undefined> {
    const event = await this.repo.get<MatchEvent>('matchingLogs', this.automaticKey(observation, revision, epoch));
    return event && event.at >= Date.now() - LOG_RETENTION ? event.automatic : undefined;
  }
  async automatic(observation: TitleObservation, revision: number, epoch: number, state: LookupState, steps: MatchStep[], logEpoch?: number): Promise<void> {
    logEpoch ??= await this.generation();
    if (state.kind === 'disabled' || state.kind === 'setup_required') return;
    const outcome: AutomaticDecision['outcome'] = { kind: state.kind,
      ...('reason' in state ? { reason: state.reason } : {}),
      ...('record' in state ? { imdbId: state.record.subject.id } : {}) };
    const previous = await this.latest(observation, revision, epoch);
    // A cached stop must retain the original search evidence and must not flood the log on scroll.
    if (previous && JSON.stringify(previous.outcome) === JSON.stringify(outcome) &&
      (steps.some(step => ['resolution_cache', 'rating_cache'].includes(step.stage)) || JSON.stringify(previous.steps) === JSON.stringify(steps))) return;
    const automatic: AutomaticDecision = { id: crypto.randomUUID(), at: Date.now(), observation, revision, epoch,
      resolverVersion: RESOLVER_VERSION, outcome, steps };
    await this.append(this.event('automatic', observation, revision, epoch, { automatic }, logEpoch), this.automaticKey(observation, revision, epoch));
  }
  async export(): Promise<MatchEvent[]> {
    await this.maintain();
    return (await this.repo.all<MatchEvent>('matchingLogs')).map(entry => entry.value).sort((a, b) => a.at - b.at);
  }
  async maintain(): Promise<void> { await this.repo.transaction(['matchingLogs'], tx => this.prune(tx, Date.now())); }
  async maintainInTransaction(tx: IDBTransaction): Promise<void> { await this.prune(tx, Date.now()); }
  async clear(): Promise<void> {
    await this.repo.transaction(['matchingLogs', 'contexts', 'state', 'resolutions'], async tx => {
      txPut(tx, 'state', 'matchingLogEpoch', (await txGet<number>(tx, 'state', 'matchingLogEpoch') ?? 0) + 1);
      tx.objectStore('matchingLogs').clear(); tx.objectStore('contexts').clear();
      const resolutions = await idbRequest(tx.objectStore('resolutions').getAll()) as Array<{ key: string; value: { trace?: unknown; traceEpoch?: number } }>;
      for (const { key, value } of resolutions) {
        const { trace: _trace, traceEpoch: _traceEpoch, ...preserved } = value;
        txPut(tx, 'resolutions', key, preserved);
      }
    }, true);
    this.failed = false;
  }
}
