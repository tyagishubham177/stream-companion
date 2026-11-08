import { netflixBrowseSurface } from '../platforms/netflix';
import { PROTOCOL_VERSION, type Request, type TitleObservation } from './contracts';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const string = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.trim().length >= min && v.length <= max && !/[\u0000-\u001f]/.test(v);
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function validRef(v: unknown): boolean {
  return isObject(v) && only(v, ['platformId', 'titleId']) && v.platformId === 'netflix' && typeof v.titleId === 'string' && /^\d{1,12}$/.test(v.titleId);
}
export function validObservation(v: unknown): v is TitleObservation {
  if (!isObject(v) || !only(v, ['ref', 'displayTitle', 'mediaType', 'year', 'aliases', 'adapterVersion']) || !validRef(v.ref) ||
    !string(v.displayTitle, 1, 300) || typeof v.mediaType !== 'string' || !['movie', 'series', 'unknown'].includes(v.mediaType) ||
    !Number.isSafeInteger(v.adapterVersion) || Number(v.adapterVersion) < 1 || Number(v.adapterVersion) > 100000) return false;
  if (v.aliases !== undefined && (!Array.isArray(v.aliases) || v.aliases.length > 5 || !v.aliases.every(a => string(a, 1, 300)))) return false;
  return v.year === undefined || (isObject(v.year) && only(v.year, ['value', 'meaning']) &&
    Number.isInteger(v.year.value) && Number(v.year.value) >= 1888 && Number(v.year.value) <= new Date().getUTCFullYear() + 5 &&
    typeof v.year.meaning === 'string' && ['movie_release', 'series_start', 'season_release', 'unknown'].includes(v.year.meaning));
}
const fields: Record<Request['type'], string[]> = {
  RELEASE_DEMAND: ['ref'],
  GET_PUBLIC_STATUS: [], OPEN_SETTINGS: [], LOOKUP: ['observation'], REFRESH: ['observation', 'revision'],
  OPEN_CORRECTION: ['observation', 'revision'], GET_STATUS: [], UPDATE_SETTINGS: ['settings'],
  SET_API_KEY: ['key'], TEST_API_KEY: [], REMOVE_API_KEY: [], GET_CONTEXT: ['contextId'],
  SEARCH_MATCHES: ['contextId', 'query', 'page'], PREVIEW_MATCH: ['contextId', 'input', 'searchId'],
  CONFIRM_MATCH: ['contextId', 'previewId'], LIST_MATCHES: [], REMOVE_MATCH: ['ref', 'revision'],
  RESET_MATCHES: [], CLEAR_RATING_CACHE: [], EXPORT_DIAGNOSTICS: [], EXPORT_MATCHING_LOG: [], CLEAR_MATCHING_LOG: [],
  GET_MARKS: ['refs'], SET_MARK: ['observation', 'watched', 'plan', 'revision', 'epoch'], UNDO_MARK: ['ref', 'operationId', 'revision', 'epoch'],
  LIST_MARKS: [], RESET_MARKS: [], EXPORT_MARKS: [], OPEN_TITLES: []
};
export function validateRequest(raw: unknown): Request {
  if (!isObject(raw) || JSON.stringify(raw).length > 16000 || raw.protocol !== PROTOCOL_VERSION ||
    typeof raw.type !== 'string' || !Object.hasOwn(fields, raw.type)) throw new Error('Unsupported extension message.');
  const type = raw.type as Request['type'];
  if (!only(raw, ['protocol', 'type', ...fields[type]]) || !fields[type].every(k => (type === 'RELEASE_DEMAND' && k === 'ref') || (type === 'PREVIEW_MATCH' && k === 'searchId') || (type === 'SET_MARK' && ['watched','plan'].includes(k)) || Object.hasOwn(raw, k))) throw new Error('Invalid extension message fields.');
  if ('observation' in raw && !validObservation(raw.observation)) throw new Error('Invalid title observation.');
  if ('ref' in raw && !validRef(raw.ref)) throw new Error('Invalid platform title.');
  if ('revision' in raw && !revision(raw.revision)) throw new Error('Invalid mapping revision.');
  if ('epoch' in raw && !revision(raw.epoch)) throw new Error('Invalid marks generation.');
  if (type === 'GET_MARKS' && (!Array.isArray(raw.refs) || raw.refs.length > 100 || !raw.refs.every(validRef))) throw new Error('Invalid marks request.');
  if (type === 'SET_MARK' && ((!('watched' in raw) && !('plan' in raw)) || ('watched' in raw && typeof raw.watched !== 'boolean') || ('plan' in raw && (typeof raw.plan !== 'string' || !['none','want','pass'].includes(raw.plan))))) throw new Error('Invalid title mark.');
  if (type === 'UNDO_MARK' && !string(raw.operationId, 36, 36)) throw new Error('Invalid undo operation.');
  if ('contextId' in raw && !string(raw.contextId, 36, 36)) throw new Error('Invalid correction context.');
  if ('previewId' in raw && !string(raw.previewId, 36, 36)) throw new Error('Invalid match preview.');
  if ('searchId' in raw && !string(raw.searchId, 36, 36)) throw new Error('Invalid search reference.');
  if (type === 'SET_API_KEY' && (typeof raw.key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.key))) throw new Error('Enter a valid OMDb key.');
  if (type === 'SEARCH_MATCHES' && (!string(raw.query, 1, 160) || !Number.isInteger(raw.page) || Number(raw.page) < 1 || Number(raw.page) > 100)) throw new Error('Enter a title and a valid search page.');
  if (type === 'PREVIEW_MATCH' && !string(raw.input, 1, 256)) throw new Error('Enter an IMDb ID or title URL.');
  if (type === 'UPDATE_SETTINGS') {
    const settings = raw.settings;
    if (!isObject(settings) || !only(settings, ['enabled', 'corner', 'cacheOnly', 'ratingsEnabled','marksEnabled','shadeWatched','fadePassed','automaticMatching','matchingLogEnabled']) ||
      ['ratingsEnabled','marksEnabled','shadeWatched','fadePassed','automaticMatching','matchingLogEnabled'].some(key => key in settings && typeof settings[key] !== 'boolean') ||
      ('enabled' in settings && typeof settings.enabled !== 'boolean') ||
      ('cacheOnly' in settings && typeof settings.cacheOnly !== 'boolean') ||
      ('corner' in settings && (typeof settings.corner !== 'string' || !['top-left', 'top-right'].includes(settings.corner)))) throw new Error('Invalid settings.');
  }
  return raw as unknown as Request;
}

export type SenderRole = 'content' | 'popup' | 'options' | 'correction' | 'titles';
export function authoriseSender(sender: chrome.runtime.MessageSender, extensionId: string, command?: Request['type']): SenderRole {
  if (sender.id !== extensionId || !sender.url) throw new Error('Message sender is not authorised.');
  let url: URL; try { url = new URL(sender.url); } catch { throw new Error('Message sender is not authorised.'); }
  if (url.protocol === 'chrome-extension:' && url.hostname === extensionId) {
    const roles: Record<string, SenderRole> = { '/popup.html': 'popup', '/options.html': 'options', '/correction.html': 'correction', '/titles.html': 'titles' };
    const role = roles[url.pathname]; if (role && !sender.tab?.incognito) return role;
  }
  if (url.origin === 'https://www.netflix.com' && sender.frameId === 0 && sender.tab?.id !== undefined && sender.documentId && !sender.tab.incognito &&
    (netflixBrowseSurface(url) || command === 'RELEASE_DEMAND' || command === 'GET_PUBLIC_STATUS')) return 'content';
  throw new Error('Message sender is not authorised.');
}
export function authoriseCommand(role: SenderRole, type: Request['type']): void {
  const allowed: Record<SenderRole, Request['type'][]> = {
    content: ['GET_PUBLIC_STATUS', 'LOOKUP', 'REFRESH', 'OPEN_CORRECTION', 'OPEN_SETTINGS', 'RELEASE_DEMAND', 'GET_MARKS','SET_MARK','UNDO_MARK','OPEN_TITLES'],
    popup: ['GET_STATUS', 'UPDATE_SETTINGS', 'OPEN_SETTINGS','OPEN_TITLES'],
    options: ['GET_STATUS', 'UPDATE_SETTINGS', 'SET_API_KEY', 'TEST_API_KEY', 'REMOVE_API_KEY', 'LIST_MATCHES', 'REMOVE_MATCH', 'RESET_MATCHES', 'CLEAR_RATING_CACHE', 'EXPORT_DIAGNOSTICS', 'EXPORT_MATCHING_LOG', 'CLEAR_MATCHING_LOG', 'OPEN_TITLES','LIST_MARKS','RESET_MARKS','EXPORT_MARKS'],
    correction: ['GET_STATUS', 'GET_CONTEXT', 'SEARCH_MATCHES', 'PREVIEW_MATCH', 'CONFIRM_MATCH', 'OPEN_SETTINGS'],
    titles: ['GET_STATUS','GET_PUBLIC_STATUS','LIST_MARKS','SET_MARK','UNDO_MARK','RESET_MARKS','EXPORT_MARKS','OPEN_SETTINGS']
  };
  if (!allowed[role].includes(type)) throw new Error('This page cannot perform that operation.');
}
