import { ExtensionBusyError } from '../shared/client';

const MAX_ACTIVE = 8;
const START_INTERVAL_MS = 400;
// Allow the first row to load together, with headroom under the worker's per-minute cap.
const BURST_ALLOWANCE_MS = (MAX_ACTIVE - 1) * START_INTERVAL_MS;

interface RatingJob {
  needed: () => boolean;
  start: () => Promise<void>;
  cancel: () => void;
}

/** Paces automatic rating messages for one document, including across catalogue navigation. */
export class RatingRequests {
  private readonly queue: RatingJob[] = [];
  private active = 0;
  private nextSlot = 0;
  private retryAfter = 0;
  private timer?: ReturnType<typeof setTimeout>;

  run<T>(needed: () => boolean, send: () => Promise<T>): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const job: RatingJob = {
        needed,
        cancel: () => resolve(undefined),
        start: async () => {
          try { resolve(await send()); }
          catch (error) {
            if (error instanceof ExtensionBusyError) {
              this.retryAfter = Math.max(this.retryAfter, error.retryAfter);
              this.queue.unshift(job);
            } else reject(error);
          }
        },
      };
      this.queue.push(job);
      this.dispatch();
    });
  }

  cancelPending(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const job of this.queue.splice(0)) job.cancel();
  }

  private dispatch(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.active < MAX_ACTIVE && this.queue.length) {
      const now = performance.now();
      const wait = Math.max(this.nextSlot - now - BURST_ALLOWANCE_MS, this.retryAfter - Date.now());
      if (wait > 0) {
        this.timer = setTimeout(() => this.dispatch(), Math.ceil(wait));
        return;
      }
      const job = this.queue.shift()!;
      if (!job.needed()) { job.cancel(); continue; }
      this.nextSlot = Math.max(now, this.nextSlot) + START_INTERVAL_MS;
      this.active++;
      void job.start().finally(() => {
        this.active--;
        this.dispatch();
      });
    }
  }
}
