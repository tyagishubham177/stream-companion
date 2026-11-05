# Changelog

Versions below are matched to their committed extension manifests. Historical tags preserve those snapshots; the latest packaged release is v0.4.0.

## 0.4.0 — Local matching evidence

- Record automatic matching outcomes, search filters, ordered candidates and failed checks.
- Connect manual searches, previews and confirmed choices, including the selected result's rank and original automatic decision.
- Review, download and clear matching logs in Settings. Logs remain local for up to 30 days, capped at 1,000 records.
- Save confirmations and their log entries atomically; reject stale/expired correction sessions and old writes after clearing history.
- Upgrade local storage without losing keys, saved matches, ratings or provider accounting.
- Verified with 423 unit tests and 12 real-MV3 browser tests. Live Netflix catalogue evidence remains labelled by the version tested in `docs/verification.md`.

## 0.3.1 — Edition and language variants

- Match supported alternate film titles using release year, director and cast evidence.
- Preserve remake/sequel safeguards and reject incomplete or contradictory evidence.
- Repeat the fixed 135-title English/Hindi audit: 115 numeric ratings, six NR states and 14 unresolved identities.

## 0.3.0 — Public film metadata

- Use cookie-free public Netflix film metadata when direct identifier links are missing.
- Match the verified film title, release year and type through OMDb.
- Improve coverage for titles including English Vinglish, Gully Boy and Baar Baar Dekho.

## 0.2.2 — Expanded hover previews and reload recovery

- Show ratings in Netflix's expanded hover previews.
- Stop invalidated content scripts cleanly after an extension reload and offer a Netflix refresh notice.

## 0.2.1 — Scroll stability

- Anchor badges to native card containers so scrolling and carousel transforms preserve alignment.
- Avoid focus jumps and redundant fetches during scroll.

## 0.2.0 — Automatic visible-title matching

- Resolve visible Netflix titles using public Netflix-to-IMDb identifier relationships from Wikidata.
- Coalesce duplicate requests and keep manual corrections available for unresolved titles.

## 0.1.0 — Initial working extension

- Introduce generic Stream Companion branding and a modular platform adapter boundary.
- Add Netflix IMDb badges, trusted OMDb key setup, manual title correction and local caches.
- Cache recent titles weekly and older supported titles monthly, with durable request budgets and cooldowns.
