import type { StreamingPlatformAdapter } from './contracts';
import { netflixAdapter } from './netflix';
import { hotstarAdapter } from './hotstar';
import { appleTvAdapter } from './apple-tv';

// Bundled adapters only. Add another platform with its exact manifest scope and tests.
export const platformAdapters: readonly StreamingPlatformAdapter[] = [netflixAdapter, hotstarAdapter, appleTvAdapter];
export const adapterFor = (url: URL): StreamingPlatformAdapter | undefined =>
  platformAdapters.find(adapter => adapter.supports(url));
