import type { TitleObservation } from '../shared/contracts';

/** A platform owns all selectors, identity extraction and supported surfaces. */
export interface StreamingPlatformAdapter {
  readonly id: string;
  readonly version: number;
  supports(url: URL): boolean;
  findTiles(root: ParentNode): Iterable<HTMLElement>;
  observeTitle(tile: HTMLElement): TitleObservation | null;
  visibleDetails(observations: readonly TitleObservation[]): TitleObservation | null;
  isObscured(): boolean;
}
