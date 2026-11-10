import type { TitleObservation } from '../shared/contracts';

/** A platform owns all selectors, identity extraction and supported surfaces. */
export interface StreamingPlatformAdapter {
  readonly id: string;
  readonly version: number;
  supports(url: URL): boolean;
  findTiles(root: ParentNode): Iterable<HTMLElement>;
  badgeContainer(tile: HTMLElement): HTMLElement | null;
  badgeCorner?(tile: HTMLElement): 'top-left' | 'top-right' | undefined;
  expandedOwner?(tile: HTMLElement): HTMLElement | undefined;
  visibleImdb?(tile: HTMLElement): number | undefined;
  artworkElement?(tile: HTMLElement): HTMLElement | null;
  observeTitle(tile: HTMLElement): TitleObservation | null;
  visibleDetails(observations: readonly TitleObservation[]): TitleObservation | null;
  isObscured(tile?: HTMLElement): boolean;
}
