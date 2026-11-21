# IMDb dataset ratings

Stream Companion uses the official IMDb ratings snapshot for scores and vote counts after it has verified a title’s IMDb ID. OMDb still supplies search results and title metadata for manual and automatic matching. JioHotstar scores shown on the streaming page keep their existing attribution.

The extension downloads the ratings-only snapshot from IMDb on demand and shares it across tabs, titles, and worker restarts. A valid download replaces the previous copy atomically. The snapshot becomes due after a day. A failed refresh leaves the last good copy available. A missing row and an unavailable snapshot produce distinct title states. Cache-only mode uses local data and clearing the rating cache removes the snapshot.

Saved IDs remain usable without an OMDb key, including mappings made before this change. Match checks and corrections still require the same evidence. Store the verified title details on new mappings so that clearing the cache does not discard their display metadata. Keep matching evidence separate from snapshot availability so a refresh failure cannot block a confirmed correction or validate an ambiguous title.

The extension fetches the same file for every user query and sends no IMDb title IDs or OMDb key to the dataset host. The snapshot stays in the browser profile. The dataset is for personal, non-commercial use under IMDb’s terms. Attribute the source in Settings and on displayed ratings.

## Implementation and verification

1. Test the download, parsing, local lookup, expiry, and recovery with synthetic gzip data. Check the parser against IMDb’s full snapshot to verify the published format and known examples.
2. Connect the dataset to verified title lookups, correction previews, and provisional Hotstar badges. Verify that a saved match still shows a score without a key, a true miss is distinguishable from a failed refresh, and an OMDb score cannot override IMDb data.
3. Update settings and attribution. Run `npm run check` and `npm run test:browser` with isolated browser fixtures.
