import { rpc } from '../shared/client';
import { titleKey } from '../shared/contracts';
import { hasMarks, markLabel, type MarkMutation, type MarkPatch, type MarksSnapshot, type TitleMark, type WatchPlan } from '../shared/marks';
import { dateLabel, element, message, notice } from './ui';

type Filter = 'all' | 'want' | 'watched' | 'pass';
const names: Record<Filter, string> = { all: 'All titles', want: 'Want to watch', watched: 'Watched', pass: 'Won’t watch' };
let snapshot: MarksSnapshot = { marks: [], epoch: 0 };
let filter: Filter = 'want';
let refreshToken = 0;
let undo: MarkMutation | undefined;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
const search = element<HTMLInputElement>('title-search');
const undoButton = element<HTMLButtonElement>('undo');

function matchesFilter(mark: TitleMark, selected = filter): boolean {
  return selected === 'all' || (selected === 'watched' ? mark.watched : mark.plan === selected);
}
function render(): void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedRef = focused?.closest<HTMLElement>('li[data-ref]')?.dataset.ref;
  const focusedControl = focused?.dataset.markControl;
  const query = search.value.trim().normalize('NFC').toLocaleLowerCase();
  const matches = snapshot.marks.filter(mark => matchesFilter(mark) && mark.observation.displayTitle.normalize('NFC').toLocaleLowerCase().includes(query));
  for (const button of element('filters').querySelectorAll<HTMLButtonElement>('button[data-filter]')) {
    const selected = button.dataset.filter as Filter;
    button.setAttribute('aria-pressed', String(selected === filter));
    button.querySelector('[data-count]')!.textContent = String(snapshot.marks.filter(mark => matchesFilter(mark, selected)).length);
  }
  element('scope').textContent = `${names[filter]} · ${matches.length} ${matches.length === 1 ? 'title' : 'titles'}${query ? ' matching your search' : ''} · Recently changed first`;
  const list = element('titles-list'); list.replaceChildren();
  for (const mark of matches) {
    const item = document.createElement('li'); item.dataset.ref = titleKey(mark.observation.ref);
    const copy = document.createElement('div'); copy.className = 'titles-copy';
    const title = document.createElement('h2'); title.textContent = mark.observation.displayTitle;
    const summary = document.createElement('p'); summary.className = 'small muted';
    summary.textContent = `${markLabel(mark)} · Changed ${dateLabel(mark.changedAt)}`;
    const link = document.createElement('a'); link.href = `https://www.netflix.com/title/${encodeURIComponent(mark.observation.ref.titleId)}`;
    link.textContent = 'Open on Netflix ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    copy.append(title, summary, link);
    const controls = document.createElement('div'); controls.className = 'title-controls';
    const seenLabel = document.createElement('label'); seenLabel.className = 'seen-control';
    const seen = document.createElement('input'); seen.type = 'checkbox'; seen.checked = mark.watched;
    seen.dataset.markControl = 'watched';
    seen.setAttribute('aria-label', `Watched ${mark.observation.displayTitle}`);
    seen.addEventListener('change', () => { void save(mark, { watched: seen.checked }, controls); });
    seenLabel.append(seen, document.createTextNode(mark.observation.mediaType === 'series' ? 'Watched so far' : 'Watched'));
    const plan = document.createElement('select'); plan.setAttribute('aria-label', `Plan for ${mark.observation.displayTitle}`);
    plan.dataset.markControl = 'plan';
    for (const [value, text] of [['none', 'No plan'], ['want', 'Want to watch'], ['pass', 'Won’t watch']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; plan.append(option);
    }
    plan.value = mark.plan;
    plan.addEventListener('change', () => { void save(mark, { plan: plan.value as WatchPlan }, controls); });
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'text-button'; clear.textContent = 'Clear all marks';
    clear.dataset.markControl = 'clear';
    clear.setAttribute('aria-label', `Clear all marks for ${mark.observation.displayTitle}`);
    clear.addEventListener('click', () => { void save(mark, { watched: false, plan: 'none' }, controls); });
    controls.append(seenLabel, plan, clear); item.append(copy, controls); list.append(item);
  }
  element('empty').hidden = matches.length > 0;
  element('empty-heading').textContent = snapshot.marks.length ? 'No titles match this view' : 'Your titles will appear here';
  element('empty-detail').textContent = snapshot.marks.length ? 'Try another name or search across all your titles.' : 'On Netflix, use Mark on a title to remember that you have watched it, want to watch it or won’t watch it.';
  element('search-all').hidden = filter === 'all' || snapshot.marks.length === 0;
  if (focusedRef && focusedControl) {
    const row = [...list.querySelectorAll<HTMLElement>('li[data-ref]')].find(item => item.dataset.ref === focusedRef);
    const control = row ? [...row.querySelectorAll<HTMLElement>('[data-mark-control]')].find(item => item.dataset.markControl === focusedControl) : undefined;
    (control ?? element('filters').querySelector<HTMLElement>('button[aria-pressed="true"]'))?.focus({ preventScroll: true });
  }
}
async function refresh(): Promise<void> {
  const token = ++refreshToken;
  const next = await rpc<MarksSnapshot>({ type: 'LIST_MARKS' });
  if (token !== refreshToken) return;
  snapshot = next; render();
}
function apply(result: MarkMutation): void {
  refreshToken++;
  const key = titleKey(result.mark.observation.ref);
  snapshot = { epoch: result.epoch, marks: [...snapshot.marks.filter(mark => titleKey(mark.observation.ref) !== key),
    ...(hasMarks(result.mark) ? [result.mark] : [])].sort((a, b) => b.changedAt - a.changedAt) };
  render();
}
async function save(mark: TitleMark, patch: MarkPatch, controls: HTMLElement): Promise<void> {
  for (const control of controls.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) control.disabled = true;
  try {
    const result = await rpc<MarkMutation>({ type: 'SET_MARK', observation: mark.observation, revision: mark.revision, epoch: snapshot.epoch, ...patch });
    apply(result); undo = result; undoButton.hidden = false; undoButton.disabled = false;
    clearTimeout(undoTimer); undoTimer = setTimeout(() => { undo = undefined; undoButton.hidden = true; }, 30000);
    notice(`${mark.observation.displayTitle}: ${markLabel(result.mark)}. Saved.`);
  } catch (error) {
    notice(message(error), true);
    try { await refresh(); } catch { notice('Your marks could not be refreshed. Reload this page before changing them.', true); }
  }
}
for (const button of element('filters').querySelectorAll<HTMLButtonElement>('button[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter as Filter; render();
});
search.addEventListener('input', render);
element('search-all').addEventListener('click', () => { filter = 'all'; render(); search.focus(); });
undoButton.addEventListener('click', () => {
  if (!undo || undoButton.disabled) return;
  const latest = undo; undoButton.disabled = true;
  void (async () => {
    try {
      const result = await rpc<MarkMutation>({ type: 'UNDO_MARK', ref: latest.mark.observation.ref,
        operationId: latest.mark.operationId, revision: latest.mark.revision, epoch: latest.epoch });
      apply(result); notice('Previous marks restored.');
    } catch (error) { notice(message(error), true); try { await refresh(); } catch { /* The original action error remains visible. */ } }
    finally { if (undo === latest) { undo = undefined; undoButton.hidden = true; clearTimeout(undoTimer); } }
  })();
});
chrome.runtime.onMessage.addListener((value: unknown) => {
  if (value && typeof value === 'object' && 'type' in value && value.type === 'SC_MARKS_CHANGED')
    void refresh().catch(error => notice(message(error), true));
});
void refresh().then(() => notice('')).catch(error => notice(message(error), true));
