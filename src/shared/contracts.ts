export const PROTOCOL_VERSION = 1;
export const RESOLVER_VERSION = 3;
export const SCHEMA_VERSION = 1;
export const PRODUCT_NAME = 'Stream Companion';

export interface PlatformTitleRef { platformId: string; titleId: string }
export interface ExternalTitleRef { namespace: 'imdb'; id: string }
export type MediaType = 'movie' | 'series' | 'unknown';
export type YearMeaning = 'movie_release' | 'series_start' | 'season_release' | 'unknown';
export interface TitleObservation {
  ref: PlatformTitleRef;
  displayTitle: string;
  mediaType: MediaType;
  year?: { value: number; meaning: YearMeaning };
  aliases?: string[];
  adapterVersion: number;
}
export interface RatingRecord {
  subject: ExternalTitleRef;
  source: 'imdb'; provider: 'omdb';
  title: string; year: string; mediaType: 'movie' | 'series';
  score: number | null; scale: 10; votes: number | null; fetchedAt: number;
}
export interface Candidate { id: string; title: string; year: string; mediaType: 'movie' | 'series' }
export interface SearchResult { candidates: Candidate[]; total: number; page: number }
export interface Mapping {
  ref: PlatformTitleRef; subject?: ExternalTitleRef;
  revision: number; method: 'manual' | 'automatic';
  evidence: TitleObservation; resolverVersion: number; rejected: string[];
  provenance?: { source: 'wikidata'; entityIds: string[]; checkedAt: number } | { source: 'netflix'; checkedAt: number };
}
export type DeferredReason = 'budget' | 'quota' | 'offline' | 'provider' | 'key' | 'storage' | 'busy' | 'clock';
export type LookupState =
  | { kind: 'rated'; record: RatingRecord; stale: boolean; method: 'manual' | 'automatic'; identitySource?: 'wikidata' | 'netflix' }
  | { kind: 'unrated'; record: RatingRecord; identitySource?: 'wikidata' | 'netflix' }
  | { kind: 'needs_match'; reason: 'insufficient_evidence' | 'ambiguous' | 'contradiction' | 'not_found' }
  | { kind: 'deferred'; reason: DeferredReason; retryAfter?: number; message: string }
  | { kind: 'setup_required' }
  | { kind: 'disabled' };
export interface LookupResult {
  state: LookupState; fingerprint: string; revision: number;
}
export interface Settings { enabled: boolean; corner: 'top-right' | 'top-left'; cacheOnly: boolean }
export interface PublicStatus {
  settings: Settings; keyConfigured: boolean;
  provider: { kind: 'ready' | 'setup' | 'paused'; message: string; retryAfter?: number };
}
export interface AppStatus extends PublicStatus {
  requests24h: number; automaticLimit: number; totalLimit: number;
  mappings: number; ratings: number;
}
export interface SavedMatch { ref: PlatformTitleRef; displayTitle: string; imdbId: string; revision: number }
export interface CorrectionContext { id: string; observation: TitleObservation; revision: number }
export interface PageStats {
  platformId: string; supported: boolean; tiles: number; rated: number; unresolved: number; cached: number;
}
export type Request =
  | { type: 'RELEASE_DEMAND'; ref?: PlatformTitleRef }
  | { type: 'OPEN_SETTINGS' }
  | { type: 'GET_PUBLIC_STATUS' }
  | { type: 'LOOKUP'; observation: TitleObservation }
  | { type: 'REFRESH'; observation: TitleObservation; revision: number }
  | { type: 'OPEN_CORRECTION'; observation: TitleObservation; revision: number }
  | { type: 'GET_STATUS' }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<Settings> }
  | { type: 'SET_API_KEY'; key: string }
  | { type: 'TEST_API_KEY' }
  | { type: 'REMOVE_API_KEY' }
  | { type: 'GET_CONTEXT'; contextId: string }
  | { type: 'SEARCH_MATCHES'; contextId: string; query: string; page: number }
  | { type: 'PREVIEW_MATCH'; contextId: string; input: string }
  | { type: 'CONFIRM_MATCH'; contextId: string; previewId: string }
  | { type: 'LIST_MATCHES' }
  | { type: 'REMOVE_MATCH'; ref: PlatformTitleRef; revision: number }
  | { type: 'RESET_MATCHES' }
  | { type: 'CLEAR_RATING_CACHE' }
  | { type: 'EXPORT_DIAGNOSTICS' };
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export type Broadcast = { type: 'SC_INVALIDATE'; ref?: PlatformTitleRef; revision?: number };
export const DEFAULT_SETTINGS: Settings = { enabled: true, corner: 'top-right', cacheOnly: false };
export const titleKey = (ref: PlatformTitleRef): string => JSON.stringify([ref.platformId, ref.titleId]);
export const ratingKey = (subject: ExternalTitleRef): string => JSON.stringify(['omdb', 'imdb', subject.namespace, subject.id]);
