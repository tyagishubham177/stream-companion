import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RatingRequests } from '../../src/content/rating-requests';
import { ExtensionBusyError } from '../../src/shared/client';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('bounds simultaneous requests and spaces new dispatches after the initial burst', async () => {
  const queue = new RatingRequests();
  const started: number[] = [];
  const finish: Array<() => void> = [];
  const results = Array.from({ length: 12 }, (_, index) => queue.run(() => true, async () => {
    started.push(index);
    await new Promise<void>(resolve => finish.push(resolve));
    return index;
  }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  for (const complete of finish.splice(0)) complete();
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await vi.advanceTimersByTimeAsync(600);
  expect(started).toHaveLength(12);
  for (const complete of finish) complete();
  await expect(Promise.all(results)).resolves.toEqual(Array.from({ length: 12 }, (_, index) => index));
});

it('waits out a worker throttle and skips work that leaves view while queued', async () => {
  const queue = new RatingRequests();
  const retryAt = Date.now() + 2500;
  const send = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new ExtensionBusyError(retryAt)).mockResolvedValue(7);
  const result = queue.run(() => true, send);
  await vi.advanceTimersByTimeAsync(0);
  let visible = true;
  const offscreenSend = vi.fn(async () => 8);
  const skipped = queue.run(() => visible, offscreenSend);
  visible = false;
  await vi.advanceTimersByTimeAsync(2499);
  expect(send).toHaveBeenCalledTimes(1);
  expect(offscreenSend).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe(7);
  await expect(skipped).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(2);
  expect(offscreenSend).not.toHaveBeenCalled();
});
