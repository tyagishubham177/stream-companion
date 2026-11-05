import type { LookupState } from '../../shared/contracts';

export function badgeText(state: LookupState | null): string {
  if (!state) return 'IMDb …';
  switch (state.kind) {
    case 'rated': return state.record.score !== null && Number.isFinite(state.record.score) && state.record.score >= 1 && state.record.score <= 10
      ? `★ IMDb ${state.record.score.toFixed(1)}${state.stale ? ' ·' : ''}` : 'IMDb NR';
    case 'unrated': return 'IMDb NR';
    case 'needs_match': return 'IMDb ?';
    case 'deferred': return 'IMDb !';
    case 'setup_required': return 'IMDb · Setup';
    case 'disabled': return '';
  }
}

export function stateDescription(state: LookupState | null): string {
  if (!state) return 'Looking up rating';
  switch (state.kind) {
    case 'rated': return state.stale ? 'Cached IMDb rating; refresh is due' : 'IMDb rating via OMDb';
    case 'unrated': return 'Rating unavailable from OMDb';
    case 'needs_match':
      return state.reason === 'contradiction' ? 'Saved match conflicts with new title details' :
        state.reason === 'not_found' ? 'Not found in OMDb with this evidence' :
        state.reason === 'ambiguous' ? 'Several titles may match' : 'Match needed';
    case 'deferred': return state.message;
    case 'setup_required': return 'Add your OMDb key in Settings';
    case 'disabled': return 'Ratings are turned off';
  }
}
