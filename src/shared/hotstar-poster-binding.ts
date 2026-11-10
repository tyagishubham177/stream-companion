import type { HotstarPosterEntry } from './contracts';

export function eligibleHotstarPosterTitle(title: string): boolean {
  return /\p{L}/u.test(title);
}

type Binding = HotstarPosterEntry['value'];

export function mergeHotstarPosterBinding(current: Binding | undefined, incoming: Binding): Binding {
  if (current === undefined) return incoming;
  if (current === null || incoming === null || current.work.titleId !== incoming.work.titleId) return null;
  if (current.metadata === null) return current;
  if (incoming.metadata === null) return { ...current, metadata: null };
  if (incoming.metadata.year === undefined) return current;
  if (current.metadata.year === undefined) return { ...current, metadata: incoming.metadata };
  if (current.metadata.year !== incoming.metadata.year || current.metadata.seasonCount !== incoming.metadata.seasonCount)
    return { ...current, metadata: null };
  return current;
}
