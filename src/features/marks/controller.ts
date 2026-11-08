import { ExtensionContextInvalidatedError, extensionContextAlive, rpc } from '../../shared/client';
import { titleKey, type PlatformTitleRef, type PublicStatus, type TitleObservation } from '../../shared/contracts';
import { observationFingerprint } from '../../shared/identity';
import { hasMarks, markLabel, type MarkMutation, type MarkPatch, type MarksSnapshot, type TitleMark } from '../../shared/marks';
import { adapterFor } from '../../platforms/registry';
import type { StreamingPlatformAdapter } from '../../platforms/contracts';
import { showReconnectNotice } from '../../content/reconnect';
import { MarksView, mountMark, type MarkMount } from './view';

interface Tile { tile: HTMLElement; observation: TitleObservation; fingerprint: string; mount: MarkMount }
export class MarksController {
  private status?: PublicStatus;
  private view?: MarksView;
  private adapter?: StreamingPlatformAdapter;
  private tiles = new Map<HTMLElement, Tile>();
  private records = new Map<string, TitleMark>();
  private known = new Set<string>();
  private pending = new Map<string, number>();
  private readSequence = 0;
  private readPauseUntil = 0;
  private markEpoch = 0;
  private generation = 0;
  private route = '';
  private observer?: MutationObserver;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private statusRequest = 0;
  private stopped = false;
  private readonly scroll = (event: Event) => { if (!this.view?.ownsEvent(event)) this.view?.close(false); };
  private readonly resize = () => { this.view?.close(false); for (const entry of this.tiles.values()) entry.mount.invalidateLayout(); this.schedule(); };
  private readonly visibility = () => { if (document.hidden) this.detach(); else void this.loadStatus(); };
  private readonly messages = (message: unknown): boolean => {
    if (!message || typeof message !== 'object' || !('type' in message)) return false;
    if (message.type === 'SC_INVALIDATE') void this.loadStatus();
    if (message.type === 'SC_MARKS_CHANGED') {
      const ref = 'ref' in message ? message.ref as PlatformTitleRef | undefined : undefined;
      if (ref) { this.known.delete(titleKey(ref)); this.pending.delete(titleKey(ref)); }
      else { this.known.clear(); this.pending.clear(); }
      this.view?.changed(ref);
      this.schedule();
    }
    return false;
  };
  start(): void {
    chrome.runtime.onMessage.addListener(this.messages);
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('popstate', this.visibility);
    window.addEventListener('scroll', this.scroll, { capture: true, passive: true });
    window.addEventListener('resize', this.resize, { passive: true });
    this.poll = setInterval(() => this.reconcile(), 1000);
    void this.loadStatus();
  }
  private async loadStatus(): Promise<void> {
    if (this.stopped || document.hidden) return;
    const request = ++this.statusRequest;
    try {
      const status = await rpc<PublicStatus>({ type: 'GET_PUBLIC_STATUS' });
      if (request !== this.statusRequest || this.stopped) return;
      this.status = status; this.retries = 0; clearTimeout(this.retry);
      this.reconcile(); this.schedule();
    } catch (error) {
      if (error instanceof ExtensionContextInvalidatedError) { this.disconnect(); return; }
      if (this.retries < 3 && !this.stopped) this.retry = setTimeout(() => void this.loadStatus(), [1000, 3000, 7000][this.retries++]);
      else this.view?.notify('Your marks could not connect. Refresh Netflix and try again.');
    }
  }
  private reconcile(): void {
    if (this.stopped) return;
    if (!extensionContextAlive()) { this.disconnect(); return; }
    const url = new URL(location.href), adapter = adapterFor(url);
    url.searchParams.delete('jbv');
    const route = `${url.pathname}?${url.searchParams.toString()}`;
    if (route !== this.route) {
      this.route = route; this.detach(); this.records.clear(); this.known.clear();
    }
    this.adapter = adapter;
    if (!this.status?.settings.enabled || this.status.settings.marksEnabled === false || !adapter || document.hidden) { this.detach(); return; }
    if (!this.view) {
      this.view = new MarksView();
      this.observer = new MutationObserver(records => {
        if (records.every(record => record.target instanceof Element && record.target.closest('[data-sc-root]') ||
          record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && node.hasAttribute('data-sc-root')))) return;
        this.schedule();
      });
      this.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['href', 'aria-label', 'aria-hidden', 'data-uia', 'hidden', 'alt'] });
      this.scan();
    }
  }
  private schedule(): void {
    if (!this.view || this.scanTimer || this.stopped) return;
    this.scanTimer = setTimeout(() => { this.scanTimer = undefined; this.scan(); }, 90);
  }
  private current(entry: Tile): boolean {
    return !this.stopped && this.tiles.get(entry.tile) === entry && entry.tile.isConnected &&
      observationFingerprint(this.adapter?.observeTitle(entry.tile) ?? invalidObservation) === entry.fingerprint;
  }
  private scan(): void {
    if (!this.view || !this.adapter || !this.status || document.hidden) return;
    const generation = this.generation;
    this.view.validate();
    for (const entry of this.tiles.values()) {
      if (!this.current(entry) || this.adapter.badgeContainer(entry.tile) !== entry.mount.container || !entry.mount.host.isConnected) this.remove(entry);
    }
    for (const tile of this.adapter.findTiles(document)) {
      if (this.tiles.has(tile)) continue;
      const observation = this.adapter.observeTitle(tile), container = this.adapter.badgeContainer(tile);
      if (!observation || !container) continue;
      const mount = mountMark(container, () => this.open(entry));
      const entry: Tile = { tile, observation, fingerprint: observationFingerprint(observation), mount };
      this.tiles.set(tile, entry);
    }
    const needed = new Map<string, PlatformTitleRef>();
    for (const entry of this.tiles.values()) {
      const key = titleKey(entry.observation.ref);
      this.render(entry);
      if (Date.now() >= this.readPauseUntil && !this.known.has(key) && !this.pending.has(key)) needed.set(key, entry.observation.ref);
    }
    const pairs = [...needed];
    for (let offset = 0; offset < pairs.length; offset += 100) {
      const batch = pairs.slice(offset, offset + 100);
      const readId = ++this.readSequence;
      for (const [key] of batch) this.pending.set(key, readId);
      void rpc<MarksSnapshot>({ type: 'GET_MARKS', refs: batch.map(([, ref]) => ref) }).then(snapshot => {
        if (this.stopped || generation !== this.generation) return;
        const active = batch.filter(([key]) => this.pending.get(key) === readId);
        if (!active.length) return;
        this.readPauseUntil = 0;
        if (snapshot.epoch < this.markEpoch) return;
        if (snapshot.epoch > this.markEpoch) { this.markEpoch = snapshot.epoch; this.records.clear(); this.known.clear(); }
        for (const [key] of active) this.known.add(key);
        const received = new Map(snapshot.marks.map(mark => [titleKey(mark.observation.ref), mark]));
        for (const [key] of active) {
          const mark = received.get(key), current = this.records.get(key);
          if (mark && (!current || mark.revision >= current.revision)) this.records.set(key, mark);
          else if (!mark && !current) this.records.delete(key);
        }
        for (const entry of this.tiles.values()) this.render(entry);
      }).catch(error => {
        if (error instanceof ExtensionContextInvalidatedError) this.disconnect();
        else if (generation === this.generation) {
          if (Date.now() >= this.readPauseUntil) this.view?.notify('Your saved marks could not be loaded. Try refreshing Netflix.');
          this.readPauseUntil = Date.now() + 5000;
        }
      }).finally(() => { for (const [key] of batch) if (this.pending.get(key) === readId) this.pending.delete(key); });
    }
  }
  private render(entry: Tile): void {
    if (!this.status || !this.adapter || !this.current(entry)) return;
    const settings = this.status.settings, mark = this.records.get(titleKey(entry.observation.ref));
    const corner = this.adapter.badgeCorner?.(entry.tile) ?? settings.corner;
    entry.mount.update(mark, entry.observation, settings.ratingsEnabled !== false, corner);
    const obscured = this.adapter.isObscured(entry.tile) || !!entry.tile.closest('[aria-hidden="true"],[hidden],[inert]');
    if (entry.mount.button.hidden !== obscured) entry.mount.button.hidden = obscured;
    const pending = !this.known.has(titleKey(entry.observation.ref));
    if (entry.mount.button.disabled !== pending) entry.mount.button.disabled = pending;
    const expanded = entry.tile.matches('[data-uia="modal-motion-container-MINI_MODAL"],[data-uia="modal-motion-container-DETAIL_MODAL"]');
    const mode = mark?.plan === 'pass' && settings.fadePassed !== false ? 'pass' : mark?.watched && settings.shadeWatched !== false && !expanded ? 'watched' : null;
    entry.mount.effect(this.adapter.artworkElement?.(entry.tile) ?? null, mode);
  }
  private open(entry: Tile): void {
    if (!this.current(entry) || !this.view || !this.known.has(titleKey(entry.observation.ref))) return;
    this.view.open({ observation: entry.observation, mark: this.records.get(titleKey(entry.observation.ref)), anchor: entry.mount.button, container: entry.mount.container,
      current: () => this.current(entry), save: patch => this.save(entry, patch) });
  }
  private apply(result: MarkMutation): void {
    if (result.epoch < this.markEpoch) return;
    if (result.epoch > this.markEpoch) { this.records.clear(); this.known.clear(); this.markEpoch = result.epoch; }
    const key = titleKey(result.mark.observation.ref), old = this.records.get(key);
    if (!old || old.revision <= result.mark.revision) { this.records.set(key, result.mark); this.known.add(key); }
    for (const entry of this.tiles.values()) this.render(entry);
  }
  private async save(entry: Tile, patch: MarkPatch): Promise<void> {
    if (!this.current(entry)) throw new Error('This tile changed. Open its marks again.');
    const ref = entry.observation.ref, mark = this.records.get(titleKey(ref)), epoch = this.markEpoch;
    let result: MarkMutation;
    try { result = await rpc<MarkMutation>({ type: 'SET_MARK', observation: entry.observation, revision: mark?.revision ?? 0, epoch, ...patch }); }
    catch (error) { this.known.delete(titleKey(ref)); this.schedule(); if (error instanceof ExtensionContextInvalidatedError) this.disconnect(); throw error; }
    if (this.stopped || !this.view) return;
    this.apply(result);
    const label = hasMarks(result.mark) ? markLabel(result.mark) : 'Marks cleared';
    this.view.notify(`${entry.observation.displayTitle}: ${label}`, async () => {
      const undone = await rpc<MarkMutation>({ type: 'UNDO_MARK', ref, operationId: result.mark.operationId, revision: result.mark.revision, epoch: result.epoch });
      this.apply(undone);
    });
  }
  private remove(entry: Tile): void {
    if (this.view?.owns(entry.mount.button)) this.view.close(false);
    entry.mount.dispose(); this.tiles.delete(entry.tile);
  }
  private detach(): void {
    this.generation++; clearTimeout(this.scanTimer); this.scanTimer = undefined;
    this.observer?.disconnect(); this.observer = undefined;
    for (const entry of this.tiles.values()) this.remove(entry);
    this.view?.dispose(); this.view = undefined; this.pending.clear();
  }
  private disconnect(): void {
    const supported = !!adapterFor(new URL(location.href)); this.dispose();
    if (supported && !document.querySelector('[data-sc-root="reconnect"]')) showReconnectNotice();
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true; this.detach(); clearInterval(this.poll); clearTimeout(this.retry);
    if (extensionContextAlive()) chrome.runtime.onMessage.removeListener(this.messages);
    document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('popstate', this.visibility);
    window.removeEventListener('scroll', this.scroll, true);
    window.removeEventListener('resize', this.resize);
  }
}
const invalidObservation: TitleObservation = { ref: { platformId: 'netflix', titleId: '0' }, displayTitle: '', mediaType: 'unknown', adapterVersion: 1 };
