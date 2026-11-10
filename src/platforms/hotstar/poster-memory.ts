import { ExtensionContextInvalidatedError, rpc } from '../../shared/client';
import { HOTSTAR_POSTER_BATCH_SIZE, HOTSTAR_POSTER_CAPACITY, type HotstarPosterBinding,
  type HotstarPosterEntry, type HotstarPosterSnapshot } from '../../shared/contracts';
import { mergeHotstarPosterBinding as merge } from '../../shared/hotstar-poster-binding';
import { normaliseTitle } from '../../shared/identity';
import { hotstarObservationPath } from './routes';
import { verifiedPosters } from './verified-posters';

type Binding = HotstarPosterEntry['value'];
const bindings = new Map<string, Binding>();
const pending = new Map<string, Binding>();
const sent = new Set<string>();
let restored = false, reading = false, writing = false;
let retryAfter = 0;
let onChange: (() => void) | undefined;

export function hotstarPosterKey(asset: string, title: string, mediaType: HotstarPosterBinding['work']['mediaType']): string {
  return JSON.stringify([asset, normaliseTitle(title), mediaType]);
}

export function onHotstarPosterMemoryChange(listener: () => void): () => void {
  onChange = listener;
  return () => { if (onChange === listener) onChange = undefined; };
}

export function restoreHotstarPosters(): void {
  if (restored || reading || Date.now() < retryAfter) return;
  reading = true;
  void rpc<HotstarPosterSnapshot>({ type: 'GET_HOTSTAR_POSTERS' }).then(({ entries }) => {
    for (const [asset, title, path, year, seasonCount] of verifiedPosters) {
      const work = hotstarObservationPath(path);
      if (!work) continue;
      const key = hotstarPosterKey(asset, title, work.mediaType);
      const seed = { work, metadata: { ...(year ? { year } : {}), ...(seasonCount ? { seasonCount } : {}) } };
      const current = bindings.get(key);
      bindings.set(key, current === undefined ? seed : merge(seed, current));
    }
    for (const { key, value } of entries) bindings.set(key, merge(bindings.get(key), value));
    restored = true;
    onChange?.();
  }).catch(error => {
    retryAfter = Date.now() + 10000;
    if (!(error instanceof ExtensionContextInvalidatedError)) console.debug('[Stream Companion] Hotstar poster memory could not be restored.');
  }).finally(() => { reading = false; });
}

export function hotstarPosterBinding(key: string): Binding | undefined { return bindings.get(key); }

function flush(): void {
  const entries = [...pending].slice(0, HOTSTAR_POSTER_BATCH_SIZE).map(([key, value]) => ({ key, value }));
  if (!entries.length) { writing = false; return; }
  for (const { key } of entries) pending.delete(key);
  void rpc<HotstarPosterSnapshot>({ type: 'SAVE_HOTSTAR_POSTERS', entries }).then(snapshot => {
    let changed = false;
    for (const { key, value } of snapshot.entries) {
      const previous = bindings.get(key);
      const merged = merge(previous, value);
      if (merged !== previous) { bindings.set(key, merged); changed = true; }
    }
    if (changed) onChange?.();
  }).catch(error => {
    if (!(error instanceof ExtensionContextInvalidatedError)) console.debug('[Stream Companion] Hotstar poster memory could not be saved.');
  }).finally(flush);
}

export function rememberHotstarPoster(key: string, binding: HotstarPosterBinding): void {
  const previous = bindings.get(key);
  if (previous === undefined && bindings.size >= HOTSTAR_POSTER_CAPACITY + verifiedPosters.length) return;
  const merged = merge(previous, binding);
  if (merged !== previous) bindings.set(key, merged);
  // Also save observations matching the built-in list, so their confirmed identity
  // survives later changes to that list. Repeated scans never requeue the same binding.
  if (sent.has(key) && merged === previous) return;
  sent.add(key);
  pending.set(key, merged);
  if (!writing) { writing = true; queueMicrotask(flush); }
}
