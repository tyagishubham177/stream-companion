import type { StreamingPlatformAdapter } from './contracts';
import { netflixAdapter } from './netflix';

// Bundled adapters only. Add another platform with its exact manifest scope and tests.
export const platformAdapters: readonly StreamingPlatformAdapter[] = [netflixAdapter];
export const adapterFor = (url: URL): StreamingPlatformAdapter | undefined =>
  platformAdapters.find(adapter => adapter.supports(url));
