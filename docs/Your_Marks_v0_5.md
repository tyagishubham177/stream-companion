# Your marks and modular browsing (0.5.0)

This implements the revised design with a separate watched fact and future plan. Watched titles retain colour under a 14% charcoal artwork layer; Want to watch can coexist with Watched; Won’t watch takes visual priority and uses grayscale. One persistent marker reflects pass > want > watched. The expanded preview restores watched brightness but retains Won’t watch treatment. Netflix labels, native controls, progress and original filter styles remain intact. Unsupported artwork isolation falls back to the marker.

Controls mount alongside the existing rating badge with a fixed reserved slot. One popover can be open across features. It is bound to the title identity, closes on recycling/navigation/scroll, supports keyboard selection and safely returns focus. A completed mutation creates one replaceable initiating-tab Undo notice. Revision/operation/generation checks prevent Undo or old snapshots from overwriting a newer choice. Native scrolling moves controls without scroll-frame position chasing; marks scan on relevant DOM changes and route changes, with cached effect/DOM updates.

Your titles is a text-first recovery page: All, Want to watch, Watched, Won’t watch; overlapping filter counts, unique All count, title search and recently changed ordering. No platform column is added in Netflix-only v1. No hidden watched-date history or automatic completion is inferred. The page stores its own title metadata independently from rating caches. It can edit, clear, export and reset marks. Marks are local to this Chrome profile and apply across Netflix profiles used here; the first-use disclosure remains visible in the library/settings. Netflix My List remains separate.

## Module settings

| Setting | Effect when off |
|---|---|
| Enable Stream Companion | Remove browsing decorations and pause automatic browsing work |
| IMDb ratings | Remove score UI and stop automatic rating dispatch; marks remain available |
| Automatic title matching | Stop new identity resolution, including queued matching requests; known identities remain usable |
| Your marks | Remove marks controls/effects; retain the recovery library and stored choices |
| Lightly shade watched artwork | Keep watched markers, restore original artwork brightness |
| Grayscale Won’t watch artwork | Keep passed markers, restore original artwork colour |
| Record matching evidence | Stop new diagnostic events and resolution traces; existing logs remain separately clearable |

The rating scheduler checks eligibility again before dispatch. A known-rating consumer can still share a request previously started for matching; explicit manual requests retain their existing accounting and cache-only rules. Source lookups and every rating request keep their durable bounds and cooldowns.

## Surface coverage and identity

Modern standard/progress cards and classic title cards use one platform adapter. Search, New & Popular, My List, named language/genre/person browse routes, expanded previews and full title details are supported where a whole-title identity is available. Classic `/watch` links never establish identity alone: the scoped title card must also provide agreeing public video/entity identifiers. Episode links, contradictory identifiers, account/profile pages and playback fail closed. New Netflix DOM variants still require validation; this is not a claim that every future page layout is supported.

In expanded previews, Mark is always visible even when the preview appears beneath a stationary pointer. Its menu stays within the native preview's hover/focus owner, fits the visible card and scrolls when needed. Moving into that menu does not leave the preview's hover area. Normal grid cards retain their quieter reveal-on-hover behaviour.

## Correction-informed matching

An actual exported matching log was inspected locally to identify failure categories. The raw export and title-choice history are not part of this repository. Regression fixtures model the following cases with synthetic names:

- Bound TVSeries metadata with at least three distinct cast members can support an exact-title/type candidate without inventing a series start year. At most two eligible candidates are checked; only a uniquely corroborated identity is accepted.
- Two eligible same-name/year film candidates can be checked using public director plus two cast matches. Two supported candidates remain ambiguous.
- A complete empty film search can try one bounded title-query request. A translated returned title requires matching year/type/director/cast and conservative sequel/edition guards.
- An already matched identity with no provider score remains NR. A manual confirmation of that same identity is not evidence that a score exists.

Automatic attempts remain bounded to three OMDb calls per resolution window. Manual mappings, rejected candidates, reset epochs and compare-and-swap checks retain priority. Resolver version 5 and metadata parser version 2 permit old misses to be reconsidered while preserving existing positive caches and user corrections. Synthetic regression tests establish the new rules; live OMDb outcomes depend on current provider data.

## Verify

```powershell
Set-Location 'D:\Coding Projects\chrome extensions\stream-companion'
npm run check
npm run test:browser
npm run package
```

Reload Stream Companion once at `chrome://extensions`, then refresh Netflix. Test a watched film, queue it for a rewatch, mark an abandoned series Won’t watch in Continue Watching, undo, and recover it from Your titles. Toggle ratings off to verify marks remain usable. New permissions or key entry are not required.
