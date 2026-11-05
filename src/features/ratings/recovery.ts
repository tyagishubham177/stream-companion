import type { LookupState } from '../../shared/contracts';

const RETRY_DELAYS = [2000, 5000, 10000] as const;

/** Never park a page timer behind a long provider circuit or restart forever. */
export function automaticRetryDelay(state: LookupState, retries: number, now: number, online: boolean): number | null {
  if (state.kind !== 'deferred' || retries >= RETRY_DELAYS.length || !online ||
    !['busy', 'offline', 'provider'].includes(state.reason)) return null;
  const eligibility = state.retryAfter === undefined ? 0 : state.retryAfter - now;
  if (!Number.isFinite(eligibility)) return null;
  const delay = Math.max(RETRY_DELAYS[retries], eligibility);
  return delay <= 60_000 ? delay : null;
}

/** Renewed visibility is demand, while key, storage and clock failures need a fix. */
export function canResumeOnDemand(state: LookupState, now: number): boolean {
  if (state.kind !== 'deferred' || ['key', 'storage', 'clock'].includes(state.reason)) return false;
  if (['quota', 'budget'].includes(state.reason) && state.retryAfter === undefined) return false;
  return state.retryAfter === undefined || (Number.isFinite(state.retryAfter) && state.retryAfter <= now);
}
