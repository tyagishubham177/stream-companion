import { ExtensionContextInvalidatedError, extensionContextAlive, rpc } from '../shared/client';
import { observationFingerprint } from '../shared/identity';
import { titleKey, type Broadcast, type LookupResult, type LookupState, type PageStats, type PlatformTitleRef, type PublicStatus, type TitleObservation } from '../shared/contracts';
import { adapterFor } from '../platforms/registry';
import type { StreamingPlatformAdapter } from '../platforms/contracts';
import { Overlay, type BadgeMount } from './overlay';
import { automaticRetryDelay, canResumeOnDemand } from '../features/ratings/recovery';
import { DAY_MS, ratingCacheState } from '../shared/freshness';
import { showReconnectNotice } from './reconnect';

interface TileState {
  tile: HTMLElement;
  observation: TitleObservation;
  fingerprint: string;
  generation: number;
  revision: number;
  button: HTMLButtonElement;
  mount: BadgeMount;
  visible: boolean;
  state: LookupState | null;
  requested: boolean;
  retries: number;
  checkedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class ContentController {
  private status: PublicStatus | null = null;
  private adapter: StreamingPlatformAdapter | undefined;
  private overlay: Overlay | null = null;
  private tiles = new Map<HTMLElement, TileState>();
  private enrichment = new Map<string, TitleObservation>();
  private knownObservations = new Map<string, TitleObservation>();
  private demandRefs = new Set<string>();
  private demandLifetimeActive = false;
  private warnedReleaseFailure = false;
  private mutation: MutationObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private routeTimer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private epoch = 0;
  private navigation = '';
  private statusRetries = 0;
  private statusRequest = 0;
  private destroyed = false;
  private contextInvalidated = false;

  private readonly reposition = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.position(); });
  };
  private readonly scroll = (event: Event): void => {
    // Cards scroll natively. Dismiss details without moving focus or measuring cards.
    if (!this.overlay || !event.composedPath().includes(this.overlay.host)) this.overlay?.close(false);
  };
  private readonly visibility = (): void => {
    clearTimeout(this.statusTimer); this.statusTimer = undefined;
    if (document.hidden) { this.reconcile(); return; }
    this.statusRetries = 0;
    void this.loadStatus();
  };
  private readonly online = (): void => {
    for (const state of this.tiles.values()) if (state.state && canResumeOnDemand(state.state, Date.now())) this.invalidateTile(state);
    this.statusRetries = 0;
    void this.loadStatus();
  };
  private readonly message = (message: unknown, _sender: chrome.runtime.MessageSender, respond: (response: unknown) => void): boolean => {
    if (!message || typeof message !== 'object') return false;
    if ('type' in message && message.type === 'SC_GET_PAGE_STATS') { respond(this.stats()); return false; }
    if ('type' in message && message.type === 'SC_INVALIDATE') {
      const update = message as Extract<Broadcast, { type: 'SC_INVALIDATE' }>;
      for (const tile of this.tiles.values()) {
        if (!update.ref || titleKey(tile.observation.ref) === titleKey(update.ref)) {
          if (update.revision !== undefined) tile.revision = Math.max(tile.revision, update.revision);
          this.invalidateTile(tile);
        }
      }
      void this.loadStatus();
    }
    return false;
  };

  start(): void {
    chrome.runtime.onMessage.addListener(this.message);
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('online', this.online);
    window.addEventListener('popstate', this.visibility);
    window.addEventListener('scroll', this.scroll, { capture: true, passive: true });
    window.addEventListener('resize', this.reposition, { passive: true });
    // A URL check covers SPA navigation even when there is no useful root mutation.
    this.routeTimer = setInterval(() => this.reconcile(), 1000);
    void this.loadStatus();
  }

  private async loadStatus(): Promise<void> {
    if (this.destroyed || document.hidden) return;
    const request = ++this.statusRequest;
    try {
      const status = await rpc<PublicStatus>({ type: 'GET_PUBLIC_STATUS' });
      if (request !== this.statusRequest || this.destroyed || document.hidden) return;
      const previous = this.status;
      this.status = status;
      if (previous && (previous.keyConfigured !== status.keyConfigured || previous.settings.cacheOnly !== status.settings.cacheOnly)) {
        for (const tile of this.tiles.values()) this.invalidateTile(tile);
      } else if (previous?.provider.kind !== 'ready' && status.provider.kind === 'ready') {
        for (const tile of this.tiles.values()) if (tile.state?.kind === 'deferred') this.invalidateTile(tile);
      }
      this.statusRetries = 0;
      clearTimeout(this.statusTimer); this.statusTimer = undefined;
      this.reconcile(); this.reposition();
    } catch (error) {
      if (error instanceof ExtensionContextInvalidatedError) { this.disconnect(); return; }
      if (request !== this.statusRequest || this.destroyed || document.hidden) return;
      // Losing the worker connection must stop loading and never leave a fabricated score.
      for (const tile of this.tiles.values()) if (!tile.state) {
        tile.state = { kind: 'deferred', reason: 'provider', message: 'Extension connection lost. Reload this page to reconnect.' };
        this.overlay?.updateBadge(tile.button, tile.observation, tile.state);
      }
      if (this.statusRetries < 3) {
        clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => void this.loadStatus(), [2000, 5000, 10000][this.statusRetries++]);
      }
    }
  }

  private routeKey(url: URL): string {
    const query = new URLSearchParams(url.search); query.delete('jbv');
    return `${url.origin}${url.pathname}?${query.toString()}`;
  }

  private reconcile(): void {
    if (this.destroyed) return;
    if (!extensionContextAlive()) { this.disconnect(); return; }
    const url = new URL(location.href);
    const adapter = adapterFor(url);
    const navigation = this.routeKey(url);
    if (navigation !== this.navigation) {
      this.navigation = navigation; this.epoch++; this.enrichment.clear(); this.knownObservations.clear(); this.detach();
    }
    this.adapter = adapter;
    if ((!this.status?.settings.enabled || this.status.settings.ratingsEnabled === false) || !adapter || document.hidden) { this.detach(); return; }
    if (!this.overlay) this.attach();
    else this.reposition();
  }

  private attach(): void {
    this.demandLifetimeActive = true;
    this.overlay = new Overlay();
    this.intersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = this.tiles.get(entry.target as HTMLElement);
        if (!state) continue;
        const wasVisible = state.visible;
        state.visible = entry.isIntersecting && entry.intersectionRatio > 0;
        if (state.visible) {
          this.renewDemand(state);
          if (!wasVisible && state.state && canResumeOnDemand(state.state, Date.now())) {
            state.requested = false; state.retries = 0;
          }
          this.queueLookup(state);
        }
        else { clearTimeout(state.timer); state.timer = undefined; this.hideTile(state); }
      }
      this.reposition();
    }, { threshold: [0, 0.1] });
    this.mutation = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        if (record.target instanceof Element && record.target.closest('[data-sc-root]')) continue;
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(n => n instanceof Element && n.hasAttribute('data-sc-root'))) continue;
        // Descendant labels and artwork can change before a recycled card's next scan.
        let owner = record.target instanceof Element ? record.target : record.target.parentElement;
        while (owner && owner !== document.documentElement) {
          if (owner instanceof HTMLElement) {
            const state = this.tiles.get(owner);
            if (state) { this.syncIdentity(state); break; }
          }
          owner = owner.parentElement;
        }
        if (record.type === 'childList' && record.removedNodes.length) {
          for (const node of record.removedNodes) if (node instanceof Element) {
            for (const state of this.tiles.values()) if (node === state.tile || node.contains(state.tile)) this.removeTile(state);
          }
        }
        changed = true;
      }
      if (changed) { this.scheduleScan(); this.reposition(); }
    });
    this.mutation.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
      attributeFilter: ['href', 'aria-label', 'aria-hidden', 'hidden', 'class', 'style', 'data-uia', 'data-testid', 'alt'],
    });
    this.scan();
  }

  private scheduleScan(): void {
    if (!this.overlay || this.scanTimer) return;
    this.scanTimer = setTimeout(() => { this.scanTimer = undefined; this.scan(); }, 100);
  }

  private observation(tile: HTMLElement): TitleObservation | null {
    const raw = this.adapter?.observeTitle(tile);
    if (!raw) return null;
    const extra = this.enrichment.get(titleKey(raw.ref));
    return extra ? { ...raw, mediaType: extra.mediaType, ...(extra.year ? { year: extra.year } : {}) } : raw;
  }

  private scan(): void {
    if (!this.overlay || !this.adapter || document.hidden) return;
    if (!this.adapter.supports(new URL(location.href))) { this.reconcile(); return; }
    for (const state of this.tiles.values()) {
      if (!state.tile.isConnected || this.adapter.badgeContainer(state.tile) !== state.mount.container || !state.mount.host.isConnected || !this.syncIdentity(state)) this.removeTile(state);
    }
    const candidates = Array.from(this.adapter.findTiles(document));
    const observations = candidates.flatMap(tile => { const o = this.adapter?.observeTitle(tile); return o ? [o] : []; });
    for (const observation of observations) {
      const key = titleKey(observation.ref);
      this.knownObservations.delete(key); this.knownObservations.set(key, observation);
    }
    while (this.knownObservations.size > 200) this.knownObservations.delete(this.knownObservations.keys().next().value!);
    const detail = this.adapter.visibleDetails([...this.knownObservations.values()]);
    if (detail) this.enrichment.set(titleKey(detail.ref), detail);
    // Limit transient enrichment to the current catalogue viewport rather than retaining history.
    if (this.enrichment.size > 200) {
      const available = new Set(observations.map(o => titleKey(o.ref)));
      for (const key of this.enrichment.keys()) if (!available.has(key)) this.enrichment.delete(key);
    }
    for (const tile of candidates) {
      const previous = this.tiles.get(tile);
      if (previous) { this.syncIdentity(previous); continue; }
      const observation = this.observation(tile);
      if (!observation) continue;
      const container = this.adapter.badgeContainer(tile);
      if (!container) continue;
      const mount = this.overlay.createBadge(container, observation.displayTitle, () => {
        const state = this.tiles.get(tile); if (state) this.open(state);
      });
      const fingerprint = observationFingerprint(observation);
      const shared = [...this.tiles.values()].find(other => other.fingerprint === fingerprint &&
        (other.state?.kind === 'rated' || other.state?.kind === 'unrated') && ratingCacheState(other.state.record) === 'fresh');
      const state: TileState = { tile, button: mount.button, mount, observation, fingerprint, generation: 0,
        revision: shared?.revision ?? 0, visible: false, state: shared?.state ?? this.initialState(),
        requested: !!shared, retries: 0, checkedAt: shared?.checkedAt };
      this.overlay.updateBadge(state.button, observation, state.state);
      this.tiles.set(tile, state); this.intersection?.observe(tile);
    }
    this.position();
  }

  private syncIdentity(state: TileState): boolean {
    const current = this.observation(state.tile);
    if (!current) {
      state.generation++; this.hideTile(state);
      return false;
    }
    const fingerprint = observationFingerprint(current);
    if (fingerprint !== state.fingerprint) {
      const previousRef = state.observation.ref;
      state.observation = current; state.fingerprint = fingerprint; state.revision = 0;
      if (titleKey(previousRef) !== titleKey(current.ref)) this.releaseTitle(previousRef);
      this.invalidateTile(state);
    }
    return true;
  }

  private invalidateTile(state: TileState): void {
    state.generation++; state.state = this.initialState(); state.requested = false; state.retries = 0;
    clearTimeout(state.timer); state.timer = undefined; this.overlay?.closeFor(state.button);
    this.overlay?.updateBadge(state.button, state.observation, state.state);
    if (state.visible) this.queueLookup(state);
  }

  private initialState(): LookupState | null {
    return this.status?.keyConfigured === false ? { kind: 'setup_required' } : null;
  }

  private release(ref?: PlatformTitleRef): void {
    if (this.contextInvalidated) return;
    if (!extensionContextAlive()) { this.disconnect(); return; }
    void rpc({ type: 'RELEASE_DEMAND', ...(ref ? { ref } : {}) }).catch(error => {
      if (error instanceof ExtensionContextInvalidatedError) { this.disconnect(); return; }
      // Releasing demand is best effort across extension reloads; persisted leases remain bounded.
      if (!this.warnedReleaseFailure) {
        this.warnedReleaseFailure = true;
        console.warn('[Stream Companion] Page demand could not be released. Reconnect by reloading the page.');
      }
    });
  }

  private releaseTitle(ref: PlatformTitleRef): void {
    const key = titleKey(ref);
    if (!this.demandRefs.has(key)) return;
    const stillVisible = [...this.tiles.values()].some(state => state.tile.isConnected && state.visible &&
      !state.button.hidden && titleKey(state.observation.ref) === key);
    if (stillVisible) return;
    this.demandRefs.delete(key);
    for (const state of this.tiles.values()) if (titleKey(state.observation.ref) === key) {
      // A released in-flight response cannot overwrite a renewed consumer later.
      state.generation++;
      state.requested = !!state.state && !canResumeOnDemand(state.state, Date.now());
      clearTimeout(state.timer); state.timer = undefined;
    }
    this.release(ref);
  }

  private renewDemand(state: TileState): void {
    if (this.demandRefs.has(titleKey(state.observation.ref))) return;
    if (state.state?.kind === 'deferred' && !canResumeOnDemand(state.state, Date.now())) {
      state.requested = true;
      this.scheduleRetry(state);
      return;
    }
    const result = state.state;
    const now = Date.now();
    const due = result && (result.kind === 'rated' || result.kind === 'unrated')
      ? ratingCacheState(result.record, now) !== 'fresh'
      : result?.kind === 'needs_match' && (!state.checkedAt || now - state.checkedAt >= DAY_MS || now < state.checkedAt);
    if (!result || due || canResumeOnDemand(result, now)) { state.requested = false; state.retries = 0; }
  }

  private hideTile(state: TileState): void {
    state.button.hidden = true; this.overlay?.closeFor(state.button);
    this.releaseTitle(state.observation.ref);
  }

  private scheduleRetry(state: TileState): void {
    if (!state.state || document.hidden || !state.visible || state.button.hidden) return;
    const delay = automaticRetryDelay(state.state, state.retries, Date.now(), navigator.onLine);
    if (delay === null) return;
    const generation = state.generation;
    const epoch = this.epoch;
    state.retries++;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (epoch === this.epoch && generation === state.generation && this.tiles.get(state.tile) === state &&
        state.visible && !state.button.hidden && !document.hidden && !this.adapter?.isObscured(state.tile)) {
        state.requested = false; void this.lookup(state);
      }
    }, delay);
  }

  private queueLookup(state: TileState): void {
    if (state.requested || state.timer || document.hidden || !this.status?.settings.enabled) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (state.visible && !state.button.hidden && state.tile.isConnected && !document.hidden && !this.adapter?.isObscured(state.tile)) void this.lookup(state);
    }, 120);
  }

  private async lookup(state: TileState, refresh = false): Promise<void> {
    if (!this.overlay || !this.syncIdentity(state) || document.hidden || !this.status?.settings.enabled) return;
    const generation = state.generation;
    const fingerprint = state.fingerprint;
    const revision = state.revision;
    const epoch = this.epoch;
    state.requested = true;
    this.demandRefs.add(titleKey(state.observation.ref));
    try {
      const result = await rpc<LookupResult>(refresh ? { type: 'REFRESH', observation: state.observation, revision } : { type: 'LOOKUP', observation: state.observation });
      if (!this.accepts(state, generation, fingerprint, epoch) || result.fingerprint !== fingerprint || result.revision < state.revision) return;
      state.revision = result.revision;
      state.checkedAt = Date.now();
      state.state = this.status?.keyConfigured === false && !['rated', 'unrated'].includes(result.state.kind)
        ? { kind: 'setup_required' } : result.state;
      this.overlay?.updateBadge(state.button, state.observation, state.state);
      if (!refresh) this.scheduleRetry(state);
      this.reposition();
    } catch (error) {
      if (error instanceof ExtensionContextInvalidatedError) { this.disconnect(); return; }
      if (!this.accepts(state, generation, fingerprint, epoch)) return;
      state.state = { kind: 'deferred', reason: 'provider', message: error instanceof Error ? error.message : 'Unable to connect to the rating service.' };
      this.overlay?.updateBadge(state.button, state.observation, state.state);
      if (!refresh) this.scheduleRetry(state);
      if (refresh) throw error;
    }
  }

  private accepts(state: TileState, generation: number, fingerprint: string, epoch: number): boolean {
    return !this.destroyed && epoch === this.epoch && state.tile.isConnected && this.tiles.get(state.tile) === state &&
      this.syncIdentity(state) && state.generation === generation && state.fingerprint === fingerprint;
  }

  private open(state: TileState): void {
    if (!this.overlay || !this.syncIdentity(state)) return;
    const generation = state.generation;
    this.overlay.show({
      observation: state.observation, state: state.state, button: state.button,
      fallbackFocus: () => state.tile.isConnected ? state.tile : [...this.tiles.values()].find(t => t !== state && t.tile.isConnected && !t.button.hidden)?.button ?? null,
      refresh: async () => {
        await this.lookup(state, true);
        this.overlay?.closeFor(state.button);
        if (state.generation === generation && state.tile.isConnected && !state.button.hidden) this.open(state);
      },
      correct: async () => { await rpc({ type: 'OPEN_CORRECTION', observation: state.observation, revision: state.revision }); },
      settings: async () => { await rpc({ type: 'OPEN_SETTINGS' }); },
    });
  }

  private position(): void {
    if (!this.overlay) return;
    const hidden = document.hidden;
    for (const state of this.tiles.values()) {
      const corner = this.adapter?.badgeCorner?.(state.tile) ?? this.status?.settings.corner ?? 'top-right';
      if (state.mount.host.dataset.corner !== corner) state.mount.host.dataset.corner = corner;
      if (hidden || this.adapter?.isObscured(state.tile) || !state.visible || !state.tile.isConnected || state.tile.closest('[aria-hidden="true"],[hidden],[inert]')) { this.hideTile(state); continue; }
      state.button.hidden = false;
      this.renewDemand(state);
      if (!state.requested) this.queueLookup(state);
    }
    this.overlay.positionPanel();
  }

  private removeTile(state: TileState): void {
    state.generation++; clearTimeout(state.timer); this.intersection?.unobserve(state.tile);
    this.overlay?.closeFor(state.button); state.mount.dispose(); this.tiles.delete(state.tile);
    this.releaseTitle(state.observation.ref);
  }

  private detach(): void {
    if (this.demandLifetimeActive) {
      this.demandLifetimeActive = false; this.demandRefs.clear(); this.release();
    }
    this.epoch++; clearTimeout(this.scanTimer); this.scanTimer = undefined;
    if (document.hidden) { this.statusRequest++; clearTimeout(this.statusTimer); this.statusTimer = undefined; }
    this.mutation?.disconnect(); this.mutation = null;
    this.intersection?.disconnect(); this.intersection = null;
    for (const tile of this.tiles.values()) this.removeTile(tile);
    this.overlay?.dispose(); this.overlay = null;
  }

  private stats(): PageStats {
    const all = [...this.tiles.values()];
    return {
      platformId: this.adapter?.id ?? (location.hostname === 'www.hotstar.com' ? 'hotstar' : 'netflix'), supported: !!this.adapter,
      tiles: all.length, rated: all.filter(t => t.state?.kind === 'rated').length,
      unresolved: all.filter(t => t.state?.kind === 'needs_match').length,
      cached: all.filter(t => t.state?.kind === 'rated' && t.state.stale).length,
    };
  }

  private disconnect(): void {
    if (this.destroyed) return;
    const notify = this.adapter?.supports(new URL(location.href));
    this.contextInvalidated = true;
    this.dispose();
    if (notify) showReconnectNotice();
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.detach(); clearTimeout(this.statusTimer); clearInterval(this.routeTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    if (!this.contextInvalidated && extensionContextAlive()) chrome.runtime.onMessage.removeListener(this.message);
    document.removeEventListener('visibilitychange', this.visibility);
    window.removeEventListener('online', this.online);
    window.removeEventListener('popstate', this.visibility);
    window.removeEventListener('scroll', this.scroll, true);
    window.removeEventListener('resize', this.reposition);
  }
}
