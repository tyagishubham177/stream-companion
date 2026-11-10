# Stream Companion

A personal Chrome extension for **IMDb ratings and title marks on Netflix and JioHotstar**. Ratings use your own OMDb key. Marks work without one.

**0.6.0 update:** **IMDb ratings** and **Mark as watched** are independent switches in the popup and Settings. Mark as watched enables Watched, Want to watch and Won’t watch; the other preferences are under Advanced settings. Both switches apply to both platforms. Your titles keeps Netflix and JioHotstar marks separate and links back to the source title.

**0.5.0 update:** Your marks adds independent watched and watch-later/skip choices, a recovery library and artwork treatments. Settings independently toggles ratings, marks, watched shading, Won’t watch grayscale, automatic matching and local matching logs. Netflix support now includes modern/classic search, New & Popular and full title details. Correction-informed matching adds cast-backed series identities, same-name film disambiguation and verified translated-title lookup.

**0.4.0 matching evidence:** Matching decisions and manual corrections now have a bounded local evidence log. Settings → Data & privacy lets you review, download or clear it. Confirmed search selections retain their result rank and the automatic checks that preceded them; nothing is uploaded or trained automatically.

**Automatic matching:** supported visible cards and expanded previews use public platform IDs first. Film title, type and release year can support a strict OMDb match. Public cast on a title page can distinguish same-name series without treating a season date as the series start. Corrections remain optional, and ambiguous matches remain unresolved.

On JioHotstar India, the extension supports search results, linked cards in browsing rows, Continue Watching, expanded previews and title details. Some collapsed Home posters expose only a name and image; expand those cards to reveal their title ID and controls. Playback, clips without a whole-title identity, live sports and account pages are outside scope. See [verification](docs/verification.md) for the tested cases and limits.

## Repository and versions

Source: [tyagishubham177/stream-companion](https://github.com/tyagishubham177/stream-companion) (public). Download the installable extension ZIP from [GitHub Releases](https://github.com/tyagishubham177/stream-companion/releases/latest). Build files, API keys, browser profiles and local logs are excluded from Git.

See the [changelog](CHANGELOG.md) for version history and [release instructions](docs/Releasing.md) for annotated tags, verification and packaging. `main` is the default branch. Published version tags remain fixed.

## Build and verify

Use Node.js 24 LTS and PowerShell:

```powershell
Set-Location 'D:\Coding Projects\chrome extensions\stream-companion'
npm ci
npm run check
```

Run the actual MV3 browser fixture suite:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) 'node_modules\.cache\ms-playwright'
npx playwright install chromium
npm run test:browser
```

Browser fixtures use disposable profiles, fake titles and fake keys. HTTP destinations outside the routed fixtures are blocked, and provider DNS is redirected to loopback as an additional guard. Automated tests do not use your streaming sessions or key.

## Install locally

1. Build with `npm run build`.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `D:\Coding Projects\chrome extensions\stream-companion\dist`.
3. In Stream Companion Settings, obtain/activate an [OMDb key](https://www.omdbapi.com/apikey.aspx), then **Save & test**. Enter it only in Settings.
4. Reload a Netflix or JioHotstar browse tab. Use the popup’s two switches, then use the IMDb badge for rating details or Mark for your watch decisions.

No server runs in production. `npm run dev` rebuilds TypeScript while editing; changes to public HTML/CSS need a fresh build. Reload the extension in `chrome://extensions` and refresh streaming tabs after updates.

To make a local ZIP:

```powershell
npm run package
```

Output: `releases\stream-companion-0.6.0.zip`. Extract it to a permanent folder before using Load unpacked. Do not load the ZIP directly. The ZIP contains the built extension, not your settings or key. Move the unpacked directory only after removing/reloading its Chrome registration.

For the installed unpacked copy, reload Stream Companion at `chrome://extensions`, allow JioHotstar access if Chrome requests it, then refresh the streaming page. Your saved key, marks, corrections, cache and usage accounting remain. See [privacy](docs/privacy.md) for what is read and shared.

## Verify in your account

1. Confirm **Save & test** succeeds; it uses one recorded provider request.
2. On Home, Search and My List, open badge details with keyboard Enter/Space, then Escape. Check that badge actions do not start playback.
3. Choose and confirm a known film/series. Verify duplicate cards update and the match survives a tab reload and browser restart.
4. Scroll, open/close title details, navigate back/forward, and check that recycled cards keep their own rating.
5. Scroll vertically and move carousels: badges should remain attached to cards, clip with their row, and keep completed ratings. Hover to expand a card and check that its rating remains visible at the upper left. Open a badge then scroll: the panel should close without jumping the page. Disable/re-enable ratings. Try cache-only mode and 200% browser zoom. Verify playback/account pages have no overlays.
6. Review provider usage and separate cache/match/key actions in Settings. Send only redacted diagnostics if troubleshooting.

Browse cards often lack release year/type. Version 0.2 resolves their public Netflix IDs automatically, rather than guessing from title popularity. If the direct ID relationship is missing, a cookie-free public Netflix film page now supplies release-year/type evidence for the strict fallback. This improves coverage for films such as Hindi titles without weakening remake checks. Series dates remain conservative. Modern browse and Continue Watching selectors were inspected on 5 November 2026; unrecognized layouts fail closed.

The [catalogue audit](docs/Catalogue_Coverage_Audit.md) records 12 English/Hindi/genre/theme/actor searches and separates naming gaps, series evidence, ambiguity and NR states.

## Caching

Ratings persist in this browser profile. Current-year films, ongoing series and series with an unknown end year refresh **weekly**. Older films and series whose explicit end year is before the current year refresh **every 30 days**. Age is approximate because OMDb supplies release years rather than exact dates. Confirmed titles without a usable score follow the same weekly/monthly policy.

Fresh cached data makes no provider call, including repeated cards and cached correction previews. Refresh becomes eligible when that title is next visible; it does not run a background timer. Failed refreshes may show a marked stale score for seven additional days. Manual Refresh and a deliberate key test can bypass freshness while respecting quota and cooldowns. Saved matches persist separately from scores; cache-only mode pauses provider fetching except a requested key test.

## Structure

- `src/platforms`: shared adapter contract and separate Netflix and JioHotstar adapters.
- `src/features/ratings`: badge presentation and retry policy.
- `src/content`: card lifecycle, visibility and accessible overlay.
- `src/background`: authorization, resolver, transactional storage and shared request scheduler.
- `src/providers`: fixed-origin OMDb transport and response normalization.
- `src/providers/wikidata.ts`: batched public identity lookup, separate cache and cooldown.
- `src/providers/netflix-metadata.ts`: cookie-free public movie metadata, bounded parsing, separate cache and cooldown.
- `src/pages`: popup, settings and correction UI.
- `src/shared`: versioned messages, identities and validation.
- `docs/Stream_Companion_Design_v1.md`: product/technical design and extension roadmap.
- `docs/verification.md`: verified evidence and open acceptance checks.

Mappings use platform + title identity. Rating caches distinguish external identity, source and provider. New platforms do not inherit another platform's corrections. Add an adapter and exact host permissions when implementing the next supported service; no runtime plugin framework is required.

The worker owns keys and network access. Request accounting and provider cooldowns survive cache clearing. The extension uses no private streaming APIs, account credentials, telemetry or remote executable code. Wikidata receives public platform IDs; OMDb receives title evidence or an IMDb ID and the API key. JioHotstar metadata comes from the current page. The existing Netflix public metadata fallback uses cookie-free requests and a 30-day cache. Public distribution needs provider-rights and product-name checks.

After reloading or updating the extension in Chrome, refresh each streaming tab. A disconnected script stops and offers a refresh button on supported browsing pages. Chrome may retain older warning entries under Errors until you clear them.
