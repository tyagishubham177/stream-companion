import type { LookupState, RatingRecord } from '../../shared/contracts';

export type BadgeState = LookupState | { kind: 'hotstar_score'; score: number } | { kind: 'poster_rated'; record: RatingRecord };

export function badgeText(state: BadgeState | null): string {
  if (!state) return 'IMDb …';
  switch (state.kind) {
    case 'hotstar_score': return `★ IMDb ${state.score.toFixed(1)}`;
    case 'poster_rated': return state.record.score === null ? 'IMDb NR' : `☆ IMDb ${state.record.score.toFixed(1)}`;
    case 'rated': return state.record.score !== null && Number.isFinite(state.record.score) && state.record.score >= 1 && state.record.score <= 10
      ? `★ IMDb ${state.record.score.toFixed(1)}${state.stale ? ' ·' : ''}` : 'IMDb NR';
    case 'unrated': return 'IMDb NR';
    case 'needs_match': return 'IMDb —';
    case 'deferred': return 'IMDb !';
    case 'setup_required': return 'IMDb · Setup';
    case 'disabled': return '';
  }
}

export function stateDescription(state: BadgeState | null): string {
  if (!state) return 'Looking up rating';
  switch (state.kind) {
    case 'hotstar_score': return 'IMDb rating shown by JioHotstar';
    case 'poster_rated': return 'Possible IMDb match by title and type';
    case 'rated': return state.stale ? 'Cached IMDb rating; refresh is due' : 'IMDb rating via OMDb';
    case 'unrated': return 'Rating unavailable from OMDb';
    case 'needs_match':
      return state.reason === 'contradiction' ? 'Saved match conflicts with new title details' :
        state.reason === 'not_found' ? 'No automatic IMDb match found yet' :
        state.reason === 'ambiguous' ? 'Several IMDb titles match; no rating selected' : 'Not enough information to identify this title automatically';
    case 'deferred': return state.message;
    case 'setup_required': return 'Add your OMDb key in Settings';
    case 'disabled': return 'Ratings are turned off';
  }
}
