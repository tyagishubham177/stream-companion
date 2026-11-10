import type { StreamingPlatformAdapter } from '../platforms/contracts';
import { ExtensionContextInvalidatedError, rpc } from '../shared/client';
import type { HotstarPosterLookupCounts, HotstarPosterRatingRequest, HotstarPosterRatingResult, Settings } from '../shared/contracts';
import { eligibleHotstarPosterTitle } from '../shared/hotstar-poster-binding';
import type { BadgeMount, Overlay } from './overlay';

interface PosterTile {
  tile: HTMLElement;
  poster: HotstarPosterRatingRequest;
  visibleSince?: number;
  mount?: BadgeMount;
}

/** Rating-only evidence, kept out of the canonical title and marks controllers. */
export class PosterRatings {
  private readonly tiles = new Map<HTMLElement, PosterTile>();
  private readonly results = new Map<string, HotstarPosterRatingResult>();
  private readonly pending = new Map<string, symbol>();
  private wake?: ReturnType<typeof setTimeout>;
  private counts: HotstarPosterLookupCounts = {};
  private epoch = 0;
  private disposed = false;

  constructor(private readonly adapter: StreamingPlatformAdapter, private readonly overlay: Overlay,
    private readonly observer: IntersectionObserver, private readonly onChange: () => void,
    private readonly onDisconnect: () => void) {}

  get size(): number { return this.tiles.size; }
  get rated(): number { return [...this.tiles.values()].filter(state => state.mount && !state.mount.button.hidden).length; }
  get lookupCounts(): HotstarPosterLookupCounts { return this.counts; }

  scan(root: ParentNode): void {
    for (const state of this.tiles.values()) this.check(state.tile);
    for (const tile of this.adapter.findPosterCandidates?.(root) ?? []) {
      if (this.tiles.has(tile)) continue;
      const poster = this.adapter.observePoster?.(tile);
      if (!poster || !eligibleHotstarPosterTitle(poster.title)) continue;
      this.tiles.set(tile, { tile, poster });
      this.observer.observe(tile);
    }
  }

  check(tile: HTMLElement): boolean {
    const state = this.tiles.get(tile);
    if (!state) return false;
    if (!tile.isConnected || this.adapter.observePoster?.(tile)?.key !== state.poster.key) {
      this.tiles.delete(tile);
      this.observer.unobserve(tile);
      this.unmount(state);
      this.releaseIfUnused(state.poster.key);
    }
    return true;
  }

  visibility(entry: IntersectionObserverEntry): void {
    const state = this.tiles.get(entry.target as HTMLElement);
    if (!state) return;
    if (entry.isIntersecting && entry.intersectionRatio > 0) state.visibleSince ??= Date.now();
    else {
      state.visibleSince = undefined;
      this.hide(state);
      this.releaseIfUnused(state.poster.key);
    }
  }

  position(settings: Settings): void {
    if (document.hidden || this.disposed) return;
    clearTimeout(this.wake); this.wake = undefined;
    if (settings.automaticMatching === false) {
      for (const state of this.tiles.values()) this.hide(state);
      this.updateCounts({});
      return;
    }
    const now = Date.now();
    const seen = new Set<string>();
    const counts: HotstarPosterLookupCounts = {};
    let next = Infinity;
    for (const state of this.tiles.values()) {
      if (state.visibleSince === undefined || !state.tile.isConnected) continue;
      const { key } = state.poster;
      const result = this.results.get(key);
      if (this.adapter.isObscured(state.tile) || state.tile.closest('[aria-hidden="true"],[hidden],[inert]')) {
        this.hide(state); continue;
      }
      if (!seen.has(key)) {
        seen.add(key);
        const bucket = result && result.expiresAt > now
          ? result.record?.score != null ? result.origin ?? 'cache' : result.outcome ?? 'retry'
          : 'waiting';
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
      if (state.mount) {
        state.mount.host.dataset.corner = settings.corner;
        if (result && result.expiresAt > now) { state.mount.button.hidden = false; continue; }
        this.unmount(state);
      }
      if (result && result.expiresAt > now) {
        if (result.record?.score != null) this.mount(state, result, settings.corner);
        continue;
      }
      // Let users scroll past rows without paying for every poster, and leave
      // worker capacity available for titles with verified platform identities.
      if (this.pending.size < 2 && !this.pending.has(key)) {
        const ready = state.visibleSince + 350;
        if (ready <= now) this.lookup(state.poster);
        else next = Math.min(next, ready);
      }
    }
    this.updateCounts(counts);
    if (next !== Infinity) this.wake = setTimeout(this.onChange, Math.max(0, next - Date.now()));
  }

  private updateCounts(counts: HotstarPosterLookupCounts): void {
    this.counts = counts;
    const value = JSON.stringify(counts);
    if (this.overlay.host.dataset.scPosterLookups !== value) this.overlay.host.dataset.scPosterLookups = value;
  }

  invalidate(): void {
    this.epoch++;
    clearTimeout(this.wake); this.wake = undefined;
    this.results.clear();
    this.updateCounts({});
    for (const state of this.tiles.values()) this.unmount(state);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    for (const tile of this.tiles.keys()) this.observer.unobserve(tile);
    this.tiles.clear();
  }

  private mount(state: PosterTile, result: HotstarPosterRatingResult, corner: Settings['corner']): void {
    const { record } = result;
    if (!record) return;
    if (this.adapter.observePoster?.(state.tile)?.key !== state.poster.key) return;
    const container = this.adapter.badgeContainer(state.tile);
    if (!container) return;
    const observation = { displayTitle: state.poster.title };
    const rating = { kind: 'poster_rated', record } as const;
    const mount = this.overlay.createBadge(container, observation.displayTitle, button => {
      if (this.adapter.observePoster?.(state.tile)?.key !== state.poster.key) return;
      this.overlay.show({ observation, state: rating, button, fallbackFocus: () => null,
        settings: async () => { await rpc({ type: 'OPEN_SETTINGS' }); } });
    });
    state.mount = mount;
    mount.host.dataset.corner = corner;
    mount.host.dataset.scRatingOrigin = result.origin ?? 'cache';
    mount.host.dataset.scRatingFetchedAt = String(record.fetchedAt);
    this.overlay.updateBadge(mount.button, observation, rating);
    mount.button.hidden = false;
  }

  private unmount(state: PosterTile): void {
    if (!state.mount) return;
    this.overlay.closeFor(state.mount.button);
    state.mount.dispose();
    state.mount = undefined;
  }

  private hide(state: PosterTile): void {
    if (!state.mount) return;
    state.mount.button.hidden = true;
    this.overlay.closeFor(state.mount.button);
  }

  private lookup(poster: HotstarPosterRatingRequest): void {
    const token = Symbol(), epoch = this.epoch;
    this.pending.set(poster.key, token);
    const active = () => !this.disposed && this.epoch === epoch && this.pending.get(poster.key) === token;
    const save = (result: HotstarPosterRatingResult) => {
      if (!active()) return;
      this.results.delete(poster.key);
      this.results.set(poster.key, result);
      while (this.results.size > 200) this.results.delete(this.results.keys().next().value!);
    };
    void rpc<HotstarPosterRatingResult>({ type: 'LOOKUP_HOTSTAR_POSTER_RATING', poster }).then(save).catch(error => {
      if (error instanceof ExtensionContextInvalidatedError) { if (active()) this.onDisconnect(); }
      else save({ record: null, expiresAt: Date.now() + 30000, retryable: true, outcome: 'retry' });
    }).finally(() => {
      if (this.pending.get(poster.key) === token) this.pending.delete(poster.key);
      if (!this.disposed) this.onChange();
    });
  }

  private releaseIfUnused(key: string): void {
    if (!this.pending.has(key) || [...this.tiles.values()].some(state => state.poster.key === key && state.visibleSince !== undefined)) return;
    void rpc({ type: 'RELEASE_DEMAND', posterKey: key }).catch(error => {
      if (error instanceof ExtensionContextInvalidatedError && !this.disposed) this.onDisconnect();
    });
  }
}
