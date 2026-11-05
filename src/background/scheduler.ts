import type { DeferredReason } from '../shared/contracts';
import { ProviderError, fetchOmdb } from '../providers/omdb';
import { Repository, idbRequest, txGet, txPut } from './repository';

export const DAY = 86400000;
export interface Credential { key: string; id: string; version: number }
export interface Circuit { kind?: 'key' | 'quota' | 'provider'; until: number; failures: number; quotaStep: number }
interface Attempt { credential: string; at: number; outcome: string }
interface Lease { credential: string; expiresAt: number }
export class DeferredError extends Error {
  constructor(readonly reason: DeferredReason, message: string, readonly retryAfter?: number) { super(message); }
}
type Reservation = { id: string; probeKind?: Circuit['kind'] } | { blocked: DeferredReason; retryAfter?: number };
interface ScheduledJob {
  explicit: boolean;
  unconditionalDemand: boolean;
  demands: Set<() => boolean>;
  promise: Promise<unknown>;
  run: () => Promise<void>;
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class Scheduler {
  private readonly inFlight = new Map<string, ScheduledJob>();
  private readonly queue: ScheduledJob[] = [];
  private running = 0;
  private readonly startWall = Date.now();
  private readonly startMonotonic = performance.now();
  constructor(readonly repo: Repository, private readonly credential: () => Promise<Credential | undefined>, private readonly fetcher = fetch,
    private readonly getEligibility?: () => Promise<{ enabled: boolean; cacheOnly: boolean }>) {}

  async reserve(credential: Credential, explicit: boolean, retest = false, now = Date.now()): Promise<Reservation> {
    return await this.repo.transaction(['attempts', 'leases', 'state'], async tx => {
      const previous = await txGet<number>(tx, 'state', 'lastClock') ?? 0;
      if (now + 60000 < previous) return { blocked: 'clock', retryAfter: previous };
      txPut(tx, 'state', 'lastClock', Math.max(previous, now));
      const attempts = await idbRequest(tx.objectStore('attempts').getAll()) as Array<{ key: string; value: Attempt }>;
      const charged = attempts.filter(x => x.value.credential === credential.id && x.value.at > now - DAY);
      for (const a of attempts) if (a.value.at < now - 2 * DAY) tx.objectStore('attempts').delete(a.key);
      const limit = explicit ? 900 : 800;
      if (charged.length >= limit) return { blocked: 'budget', retryAfter: Math.min(...charged.map(x => x.value.at)) + DAY };
      const leases = await idbRequest(tx.objectStore('leases').getAll()) as Array<{ key: string; value: Lease }>;
      const active = leases.filter(x => x.value.expiresAt > now);
      for (const lease of leases) if (lease.value.expiresAt <= now) tx.objectStore('leases').delete(lease.key);
      const circuit = await txGet<Circuit>(tx, 'state', `provider:${credential.id}`);
      if (circuit?.kind === 'key' && !retest) return { blocked: 'key' };
      if (circuit?.kind && !(circuit.kind === 'key' && retest)) {
        if (circuit.until > now) return { blocked: circuit.kind, retryAfter: circuit.until };
        if (active.some(x => x.value.credential === credential.id)) return { blocked: 'busy', retryAfter: now + 1000 };
      }
      const nextAt = await txGet<number>(tx, 'state', 'nextDispatch') ?? 0;
      if (active.length >= 2 || nextAt > now) return { blocked: 'busy', retryAfter: Math.max(now + 100, nextAt) };
      const id = crypto.randomUUID();
      txPut(tx, 'attempts', id, { credential: credential.id, at: now, outcome: 'reserved' });
      txPut(tx, 'leases', id, { credential: credential.id, expiresAt: now + 20000 });
      txPut(tx, 'state', 'nextDispatch', now + 500);
      return { id, probeKind: circuit?.kind };
    }, true);
  }

  private async finish(id: string, credential: Credential, error?: unknown, probeKind?: Circuit['kind']): Promise<void> {
    const current = await this.credential();
    await this.repo.transaction(['attempts', 'leases', 'state'], async tx => {
      const attempt = await txGet<Attempt>(tx, 'attempts', id);
      if (attempt) txPut(tx, 'attempts', id, { ...attempt, outcome: error instanceof ProviderError ? error.kind : error ? 'failed' : 'success' });
      tx.objectStore('leases').delete(id);
      if (current?.id !== credential.id || current.version !== credential.version) return;
      const key = `provider:${credential.id}`;
      const old = await txGet<Circuit>(tx, 'state', key) ?? { until: 0, failures: 0, quotaStep: 0 };
      if (!error || (error instanceof ProviderError && ['not_found', 'identity'].includes(error.kind))) {
        if ((old.kind === 'key' || old.kind === 'quota') && old.kind !== probeKind) return;
        txPut(tx, 'state', key, { until: 0, failures: 0, quotaStep: 0 }); return;
      }
      if (!(error instanceof ProviderError)) return;
      if (error.kind === 'key') txPut(tx, 'state', key, { ...old, kind: 'key', until: Number.MAX_SAFE_INTEGER });
      else if (error.kind === 'quota') {
        const step = old.quotaStep + 1;
        txPut(tx, 'state', key, { ...old, kind: 'quota', quotaStep: step, until: Date.now() + Math.min(24, 2 ** Math.min(step - 1, 5)) * 3600000 });
      } else {
        const failures = old.failures + 1;
        // A response from another already-running request must not clear a key/quota circuit.
        if (old.kind === 'key' || old.kind === 'quota') return;
        txPut(tx, 'state', key, { ...old, failures, kind: 'provider', until: Date.now() + (failures >= 3 ? 60000 : 2000 * 2 ** (failures - 1)) });
      }
    });
  }

  request<T>(params: Record<string, string>, explicit: boolean, decode: (raw: unknown) => T, retest = false, isDemandActive?: () => boolean): Promise<T> {
    return this.enqueue(params, explicit, decode, retest, isDemandActive);
  }
  private async checkEligibility(job: ScheduledJob, retest: boolean): Promise<void> {
    const settings = await this.getEligibility?.();
    if (settings?.cacheOnly && !retest) throw new DeferredError('provider', 'Cache-only mode is on. Turn it off in Settings to fetch ratings.');
    if (!job.explicit && settings?.enabled === false) throw new DeferredError('busy', 'Ratings are disabled. Automatic lookups are paused.');
    if (!job.explicit && !job.unconditionalDemand && ![...job.demands].some(active => active())) {
      throw new DeferredError('busy', 'Title no longer visible. Lookup deferred until it is needed again.');
    }
  }
  private async enqueue<T>(params: Record<string, string>, explicit: boolean, decode: (raw: unknown) => T, retest: boolean, isDemandActive?: () => boolean): Promise<T> {
    const credential = await this.credential();
    if (!credential) throw new DeferredError('key', 'Add your OMDb key in Settings.');
    const key = JSON.stringify([credential.id, credential.version, Object.entries(params).sort(), retest]);
    const existing = this.inFlight.get(key);
    if (existing) {
      // One disappearing tile cannot cancel another document's demand for the same ID.
      existing.explicit ||= explicit;
      if (isDemandActive) existing.demands.add(isDemandActive);
      else existing.unconditionalDemand = true;
      return existing.promise as Promise<T>;
    }
    if (this.queue.length >= 100) throw new DeferredError('busy', 'Lookups are busy. Try again when fewer titles are visible.');
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const job: ScheduledJob = {
      explicit, unconditionalDemand: !isDemandActive, demands: new Set(isDemandActive ? [isDemandActive] : []), promise: result,
      run: async () => {
        try {
          if (Math.abs((Date.now() - this.startWall) - (performance.now() - this.startMonotonic)) > 300000)
            throw new DeferredError('clock', 'The system clock changed. Restart the browser after correcting the clock.');
          if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new DeferredError('offline', 'Offline. Cached ratings remain available.');
          const reserveEligible = async (): Promise<Reservation> => {
            await this.checkEligibility(job, retest);
            const priority = job.explicit;
            const reservation = await this.reserve(credential, priority, retest);
            // An explicit consumer may attach while the automatic budget transaction runs.
            if ('blocked' in reservation && reservation.blocked === 'budget' && !priority && job.explicit) {
              await this.checkEligibility(job, retest);
              return await this.reserve(credential, true, retest);
            }
            return reservation;
          };
          let reservation: Reservation = await reserveEligible();
          let waits = 0;
          while ('blocked' in reservation && reservation.blocked === 'busy' && waits++ < 5) {
            await pause(Math.min(1000, Math.max(100, (reservation.retryAfter ?? Date.now() + 500) - Date.now())));
            reservation = await reserveEligible();
          }
          if ('blocked' in reservation) throw new DeferredError(reservation.blocked, deferredMessage(reservation.blocked), reservation.retryAfter);
          try {
            const current = await this.credential();
            if (current?.id !== credential.id || current.version !== credential.version) throw new DeferredError('key', 'The API key changed. Try again.');
            // A reservation stays charged if demand/settings change before the fetch;
            // finish still releases its lease without changing the provider circuit.
            await this.checkEligibility(job, retest);
            const value = decode(await fetchOmdb(credential.key, params, this.fetcher));
            await this.finish(reservation.id, credential, undefined, reservation.probeKind); resolveResult(value);
          } catch (error) { await this.finish(reservation.id, credential, error, reservation.probeKind); throw error; }
        } catch (error) { rejectResult(error); }
      },
    };
    this.queue.push(job);
    this.inFlight.set(key, job);
    this.pump();
    try { return await result; } finally { this.inFlight.delete(key); }
  }
  private pump(): void {
    while (this.running < 2 && this.queue.length) {
      const index = this.queue.findIndex(x => x.explicit);
      const task = this.queue.splice(index < 0 ? 0 : index, 1)[0]; this.running++;
      void task.run().finally(() => { this.running--; this.pump(); });
    }
  }
  async status(): Promise<{ count: number; circuit?: Circuit }> {
    const credential = await this.credential(); if (!credential) return { count: 0 };
    const attempts = await this.repo.all<Attempt>('attempts');
    return { count: attempts.filter(x => x.value.credential === credential.id && x.value.at > Date.now() - DAY).length,
      circuit: await this.repo.get<Circuit>('state', `provider:${credential.id}`) };
  }
}
export function deferredMessage(reason: DeferredReason): string {
  const messages: Record<DeferredReason, string> = {
    budget: 'The local request allowance is used up. Cached ratings remain available.',
    quota: 'OMDb has paused requests for this key. Try again after the cooldown.',
    offline: 'Offline. Cached ratings remain available.', provider: 'The rating service is temporarily unavailable.',
    key: 'Check or activate your OMDb key in Settings.', storage: 'Local storage failed. New lookups are paused.',
    busy: 'Lookups are busy. Try again shortly.', clock: 'The system clock moved backwards. Correct the clock before new lookups.'
  };
  return messages[reason];
}
