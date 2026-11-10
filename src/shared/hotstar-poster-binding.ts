import type { HotstarPosterEntry } from './contracts';

export function eligibleHotstarPosterTitle(title: string): boolean {
  const words = (title.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [])
    .filter(word => /\p{L}/u.test(word))
    .map(word => word.match(/[\p{L}\p{N}]/gu)!.length);
  return words.length === 1 ? words[0] >= 9 :
    words.filter(length => length >= 2).length >= 2 && words.reduce((total, length) => total + length, 0) >= 8;
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
