# Matching evidence and corrections (0.4.0)

The previous version persisted the current manual mapping, its source observation, revision and rejected IMDb IDs. It did not retain correction searches, their result order, preview choices, or the automatic checks that stopped matching. Aggregate diagnostics could not explain why a user confirmed the first result.

## Why manual rank one can differ from automatic matching

| Flow | Query and decision |
|---|---|
| Automatic | A verified title plus usable release/start year and movie/series type; complete search result set and a unique supported candidate. Direct streaming-to-IMDb links and corroborated edition credits are separate supported paths. |
| Manual search | User-entered title text plus page, without automatic year/type filters. A preview rejects explicit contradictions in the observed year/type; the user supplies the final identity judgement. |

A first result can therefore be correct yet lack automatic evidence, have a different provider spelling, be absent under stricter filters, or sit among ambiguous candidates. Search rank by itself is not proof. This release adds evidence collection and keeps existing matching rules; it does not generalize a correction to other titles or train a model automatically. The saved identity is reused immediately for that streaming title.

## Recorded chain

1. An automatic decision records resolver/app versions, source title reference and observation, mapping revision/reset epoch, source outcomes, enriched evidence, actual search query/year/type, total/completeness, ordered candidates and failed checks, and final status. Numeric-rating absence (`unrated`) is distinct from unresolved identity or a provider deferral.
2. Opening correction snapshots the exact decision for the observation/revision/epoch. It does not borrow an unrelated latest lookup. A missing historical decision stays absent.
3. Each successful manual search has a worker-issued ID and records query, page, ordered candidates and total. Empty searches are recorded too.
4. Preview records the selected IMDb work. Search-based previews retain the particular search ID, query, page, position within that displayed page and page-offset rank. Starting another search does not relabel an existing preview. Pasted IMDb IDs/URLs have no inferred search origin; raw input URLs are not recorded.
5. Successful confirmation is the label. The mapping update, context consumption and confirmed event commit together under revision/reset/preview checks. The event embeds its automatic snapshot, selected candidate, search provenance, prior identity, and the selected candidate's checks against the available automatic evidence. Preview alone, stale/expired contexts and failed saves do not create labels. Later removal/reset is recorded separately as withdrawal of the saved identity.

`rank` is `(page - 1) * 10 + position`, where position is the order in the displayed supported candidates. Episodes/games are filtered from these candidates by the existing provider parser. It is not a claim about an IMDb-wide popularity ranking or hidden provider entries.

Provider failures record bounded reason codes, never raw exception text or provider responses. Actual stored credentials, credential fingerprints, browser/account IDs, cookies, headers, request URLs and playback events are not passed to the logger. Title/search history is deliberately present and is disclosed in the correction page and Settings.

## Retention, clearing and inspection

- Local only: no upload, telemetry endpoint, extra permission or training pipeline.
- Up to 1,000 records for 30 days, including at most 500 automatic decisions. Repeated cached outcomes reuse original evidence. Pruning runs at worker startup, writes, periodic maintenance and export.
- A confirmed event embeds its essential decision and search provenance; older individual events can be evicted independently. Counts summarize retained history, not lifetime usage or independently verified match accuracy.
- Settings → Data & privacy → Review matching log displays a summary and JSON. Download matching log saves the reviewed snapshot. Ordinary Download diagnostics remains aggregate and excludes titles/searches.
- Clear matching log also expires open correction sessions and removes cached diagnostic traces. A durable generation rejects late writes and prevents cached old trace resurrection. Mapping/rating/source caches, the key, request accounting and cooldowns are preserved.
- Logging failures are reported separately in Settings and aggregate diagnostics. Automatic ratings remain usable. A manual match whose atomic log write fails is not falsely acknowledged as saved.

## Using the evidence to improve matching

After updating, browse and correct misses normally. Review/download the log and deliberately share the JSON when analysis is wanted. Group confirmed selections by original stop stage and check flags; compare automatic filters with manual queries, look for missing year/type coverage, provider spelling/edition differences, incomplete candidate sets and transient failures. Compare rank-one confirmations only among search-based confirmations. Retest any rule change against the fixed English/Hindi audit cohort and negative remake/sequel/episode cases before widening automatic acceptance.

The log starts with this version. Past searches cannot be reconstructed, and older cached failures may have only a cached-stop reason. User confirmation is useful supervision but can still be mistaken; it is not independent ground truth.

## Verification and local commands

```powershell
Set-Location 'D:\Coding Projects\chrome extensions\stream-companion'
npm run check
npm run test:browser
npm run package
```

Unit tests cover persistence, correlation, candidate checks, storage migration, bounded retention, atomic rollback, explicit health reporting and in-flight clear races. Disposable real-MV3 browser tests cover missing-title → search → preview → confirmation, first-result provenance, another search after preview, direct-ID no-rank behavior, page-two rank, invalid confirmations, review/download and clear controls, along with prior scrolling, hover, cache and reload regressions. These synthetic tests do not prove additional live Netflix match coverage. Reload Stream Companion in `chrome://extensions`, then refresh Netflix to activate the new version. Existing key, saved matches and rating cache are preserved.
