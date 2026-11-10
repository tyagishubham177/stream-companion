import { platformLabel } from '../platforms/links';
import { rpc } from '../shared/client';
import type { CorrectionContext, CorrectionSearchResult, LookupResult, RatingRecord } from '../shared/contracts';
import { dateLabel, element, imdbLink, message, notice, streamingLink } from './ui';

interface Preview { previewId: string; record: RatingRecord }
let context: CorrectionContext | undefined;
let selected: Preview | undefined;
let searchState: CorrectionSearchResult | undefined;
let lastQuery = '';
let busy = false;
let saved = false;

function updateControls(): void {
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#correction-workspace button, #correction-workspace input')) control.disabled = busy || saved;
  element<HTMLButtonElement>('previous').disabled = busy || saved || !searchState || searchState.page <= 1;
  element<HTMLButtonElement>('next').disabled = busy || saved || !searchState || searchState.page * 10 >= searchState.total;
  element<HTMLButtonElement>('confirm').disabled = busy || saved || !selected;
  element('correction-workspace').setAttribute('aria-busy', String(busy));
}

async function perform(task: () => Promise<void>): Promise<void> {
  if (busy || saved) return;
  busy = true;
  updateControls();
  try { await task(); }
  catch (error) { notice(message(error), true); }
  finally { busy = false; updateControls(); }
}

async function preview(input: string, searchId?: string): Promise<void> {
  if (!context) throw new Error('Open match correction from a streaming title to continue.');
  notice('Loading the title preview…');
  selected = undefined;
  element('preview').hidden = true;
  element('preview-heading').textContent = 'Loading preview…';
  element('preview-hint').hidden = false;
  element('preview-hint').textContent = 'Checking the selected IMDb title with OMDb.';
  const result = await rpc<Preview>({ type: 'PREVIEW_MATCH', contextId: context.id, input, ...(searchId ? { searchId } : {}) }).catch(error => {
    element('preview-heading').textContent = 'Preview unavailable';
    element('preview-hint').textContent = 'Check the status message, then try a candidate or IMDb title ID again.';
    throw error;
  });
  selected = result;
  const { record } = result;
  element('preview-heading').textContent = record.title;
  element('preview-hint').hidden = true;
  element('preview-detail').textContent = `${record.year} · ${record.mediaType === 'series' ? 'Series' : 'Movie'}`;
  element('preview-score').textContent = record.score === null ? 'NR' : record.score.toFixed(1);
  element('preview-votes').textContent = record.votes === null ? 'Vote count unavailable' : `${record.votes.toLocaleString()} votes`;
  element('preview-fetched').textContent = `IMDb rating via OMDb · Fetched ${dateLabel(record.fetchedAt)}`;
  element('preview-link').replaceChildren(imdbLink(record.subject.id));
  element('preview').hidden = false;
  notice(record.score === null ? 'This title has no usable rating from OMDb. You can still confirm its identity.' : 'Review the title, year and type, then confirm your match.');
}

async function search(query: string, page: number): Promise<void> {
  if (!context) throw new Error('Open match correction from a streaming title to continue.');
  notice('Searching OMDb…');
  const result = await rpc<CorrectionSearchResult>({ type: 'SEARCH_MATCHES', contextId: context.id, query, page });
  lastQuery = query;
  searchState = result;
  const list = element<HTMLUListElement>('results');
  list.replaceChildren();
  for (const candidate of result.candidates) {
    const item = document.createElement('li');
    const copy = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'result-title';
    title.textContent = candidate.title;
    const detail = document.createElement('p');
    detail.className = 'small muted';
    detail.textContent = `${candidate.year} · ${candidate.mediaType === 'series' ? 'Series' : 'Movie'}`;
    copy.append(title, detail);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Preview';
    button.setAttribute('aria-label', `Preview ${candidate.title}, ${candidate.year}`);
    button.addEventListener('click', () => { void perform(() => preview(candidate.id, result.searchId)); });
    item.append(copy, button);
    list.append(item);
  }
  element('search-summary').textContent = result.candidates.length
    ? `${result.total.toLocaleString()} ${result.total === 1 ? 'candidate' : 'candidates'} · Page ${result.page}. Preview a result to check its identity.`
    : 'No matching candidates from OMDb. Try another title name or enter an IMDb title ID.';
  element('pagination').hidden = result.total <= 10;
  element('page-label').textContent = `Page ${result.page}`;
  notice('');
}

element<HTMLFormElement>('search-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = element<HTMLInputElement>('query').value.trim();
  if (query) void perform(() => search(query, 1));
});
element<HTMLFormElement>('direct-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = element<HTMLInputElement>('imdb-input').value.trim();
  if (input) void perform(() => preview(input));
});
element('previous').addEventListener('click', () => {
  if (searchState && searchState.page > 1) void perform(() => search(lastQuery, searchState!.page - 1));
});
element('next').addEventListener('click', () => {
  if (searchState && searchState.page * 10 < searchState.total) void perform(() => search(lastQuery, searchState!.page + 1));
});
element('confirm').addEventListener('click', () => {
  if (!context || !selected) return;
  void perform(async () => {
    const result = await rpc<LookupResult>({ type: 'CONFIRM_MATCH', contextId: context!.id, previewId: selected!.previewId });
    if (result.state.kind !== 'rated' && result.state.kind !== 'unrated') throw new Error('The match was not confirmed. Reload this page and review the title again.');
    saved = true;
    notice('Match saved. Its rating badges will update on your streaming page. You can close this tab.');
    element<HTMLButtonElement>('confirm').textContent = 'Match saved';
  });
});

void (async () => {
  try {
    const contextId = new URL(location.href).searchParams.get('context');
    if (!contextId || !/^[a-zA-Z0-9-]{16,80}$/.test(contextId)) throw new Error('Open “Wrong match?” from a title’s rating details to start a correction.');
    context = await rpc<CorrectionContext>({ type: 'GET_CONTEXT', contextId });
    const observation = context.observation;
    element('source-title').textContent = observation.displayTitle;
    element('source-detail').textContent = [
      platformLabel(observation.ref.platformId),
      observation.mediaType === 'unknown' ? 'Type unknown' : observation.mediaType === 'series' ? 'Series' : 'Movie',
      observation.year ? `${observation.year.value} (${observation.year.meaning.replaceAll('_', ' ')})` : 'Year unavailable',
    ].join(' · ');
    const sourceLink = streamingLink(observation);
    if (sourceLink) element('source-link').append(sourceLink);
    element<HTMLInputElement>('query').value = observation.displayTitle;
    element('correction-workspace').hidden = false;
    updateControls();
    notice('Search for the correct film or series, or enter its IMDb title ID.');
  } catch (error) {
    element('source-title').textContent = 'Title context unavailable';
    element('source-detail').textContent = 'Return to the streaming page and open a new correction.';
    notice(message(error), true);
  }
})();
