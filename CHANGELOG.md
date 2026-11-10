# Changelog

Versions below are matched to their extension manifests. Historical tags preserve those snapshots.

## 0.6.3 — More Hotstar ratings on first view

- Search short poster titles and check up to four result pages for a unique exact match. Stop early when two works share the same title and type.
- Report fresh lookups, cache hits and unresolved results for visible unlinked posters in the popup.

## 0.6.2 — Hotstar poster coverage

- Look up visible Hotstar posters that expose a title and type but no title link, without requiring hover or playback. An outlined star identifies a possible IMDb title match; ambiguous searches stay blank.
- Cache and deduplicate those lookups separately from confirmed Hotstar identities. Keep watch marks and saved corrections tied to a verified title link.

## 0.6.1 — Hotstar ratings before hover

- Remember confirmed poster identities across Home, TV and reloads. Include a small set of verified public posters that can be rated before a first hover.
- Use Hotstar’s visible featured IMDb score when the accessible metadata repeats it.
- Retry incomplete searches for completed series using the corroborated IMDb start year, and require an exact season count before accepting a rating.

## 0.6.0 — JioHotstar and simpler feature controls

- Put independent IMDb ratings and Mark as watched switches in the popup and at the top of Settings.
- Bring ratings, watched/plan marks and Undo to supported JioHotstar India cards, expanded previews and title details.
- Use JioHotstar IDs from Wikidata, reliable film release years and public title-page credits to resolve ratings. Keep series identity separate from episode links and season years.
- Support the TV catalogue, use Hotstar’s displayed IMDb scores, and corroborate series through a verified year and season count. Retain controls on posters whose own expanded preview establishes their identity.
- Keep marks and corrections separate by platform, with canonical title links in Your titles.

## 0.5.0 — Your marks, modular controls and catalogue coverage

- Store an explicit watched flag separately from a want-to-watch or won’t-watch plan. Watched artwork retains colour under a light shade; passed titles use grayscale.
- Add stable Mark controls, revision-safe Undo, duplicate/cross-tab updates and a searchable Your titles recovery page with export/reset controls.
- Keep Mark visible immediately in expanded previews, with menus inside Netflix's native hover and focus boundary, including scaled and narrow cards.
- Preserve the pressed Mark/menu control through native focus scrolling, preventing menu dismissal and click-through while retaining deliberate drag cancellation.
- Independently toggle ratings, marks, both artwork effects, automatic matching and local matching-log recording in Settings.
- Support modern/classic search and New & Popular cards, language/genre/person browsing and full title details. Playback/account surfaces remain outside scope.
- Improve matching from confirmed-correction failure patterns: series require corroborating cast, duplicate film candidates require unique matching credits, translated film aliases require type/year/director/cast proof. Search rank alone never determines identity.
- Preserve keys, corrections, caches and provider accounting during schema 3 migration; user marks have no expiry.

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
