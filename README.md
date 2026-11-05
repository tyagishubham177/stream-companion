# Stream Companion

A personal Chrome extension with generic streaming branding and a modular platform boundary. **V1 adds IMDb ratings and title matching to Netflix.** The data provider is OMDb; you supply your own key in extension Settings.

**0.3 update:** visible cards and expanded hover previews resolve automatically. Direct Netflix-to-IMDb mappings are checked first; films without those links can now use Netflix’s public title, release year and movie type for a strict OMDb match. Opening each title is unnecessary. Corrections remain optional, and ambiguous matches remain unresolved.

The working name is independent of Netflix, IMDb and any future feature. Other streaming platforms are not implemented yet. This local release candidate has passed an initial live Netflix/OMDb check on Search and My List; broader catalogue acceptance remains open. See `docs/verification.md` for the exact evidence and limits.

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

Browser fixtures use a disposable profile, fake titles and a fake key. All HTTP destinations except routed fixtures are blocked, and provider DNS is redirected to loopback as an additional guard. No real API key or Netflix session is used by the automated tests.

## Install locally

1. Build with `npm run build`.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `D:\Coding Projects\chrome extensions\stream-companion\dist`.
3. In Stream Companion Settings, obtain/activate an [OMDb key](https://www.omdbapi.com/apikey.aspx), then **Save & test**. Enter it only in Settings.
4. Reload a Netflix browse tab. Click an IMDb badge to view details or choose the correct movie/series. Confirmed matches persist in this Chrome profile.

No server runs in production. `npm run dev` rebuilds TypeScript while editing; changes to public HTML/CSS need a fresh build. Reload the extension in `chrome://extensions` and reload Netflix after updates.

To make a local ZIP:

```powershell
npm run package
```

Output: `releases\stream-companion-0.3.0.zip`. Extract it to a permanent folder before using Load unpacked. Do not load the ZIP directly. The ZIP contains the built extension, not your settings or key. Move the unpacked directory only after removing/reloading its Chrome registration.

For the installed unpacked copy, reload Stream Companion at `chrome://extensions`, allow Netflix public-title-page access if Chrome requests it, then reload Netflix. Your saved key, corrections, cache and usage accounting remain. See `docs/Automatic_Ratings_v0_2.md` for the updated behavior and privacy details.

## Verify in your account

1. Confirm **Save & test** succeeds; it uses one recorded provider request.
2. On Home, Search and My List, open badge details with keyboard Enter/Space, then Escape. Check that badge actions do not start playback.
3. Choose and confirm a known film/series. Verify duplicate cards update and the match survives a tab reload and browser restart.
4. Scroll, open/close title details, navigate back/forward, and check that recycled cards keep their own rating.
5. Scroll vertically and move carousels: badges should remain attached to cards, clip with their row, and keep completed ratings. Hover to expand a card and check that its rating remains visible at the upper left. Open a badge then scroll: the panel should close without jumping the page. Disable/re-enable ratings. Try cache-only mode and 200% browser zoom. Verify playback/account pages have no overlays.
6. Review provider usage and separate cache/match/key actions in Settings. Send only redacted diagnostics if troubleshooting.

Browse cards often lack release year/type. Version 0.2 resolves their public Netflix IDs automatically, rather than guessing from title popularity. If the direct ID relationship is missing, a cookie-free public Netflix film page now supplies release-year/type evidence for the strict fallback. This improves coverage for films such as Hindi titles without weakening remake checks. Series dates remain conservative. Modern browse and Continue Watching selectors were inspected on 5 November 2026; unrecognized layouts fail closed.

## Caching

Ratings persist in this browser profile. Current-year films, ongoing series and series with an unknown end year refresh **weekly**. Older films and series whose explicit end year is before the current year refresh **every 30 days**. Age is approximate because OMDb supplies release years rather than exact dates. Confirmed titles without a usable score follow the same weekly/monthly policy.

Fresh cached data makes no provider call, including repeated cards and cached correction previews. Refresh becomes eligible when that title is next visible; it does not run a background timer. Failed refreshes may show a marked stale score for seven additional days. Manual Refresh and a deliberate key test can bypass freshness while respecting quota and cooldowns. Saved matches persist separately from scores; cache-only mode pauses provider fetching except a requested key test.

## Structure

- `src/platforms`: generic adapter contract and isolated Netflix implementation.
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

The worker owns keys and network access. Request accounting and provider cooldowns survive cache clearing. No production backend, telemetry, login, private Netflix API or remote executable code is included. Ratings are attributed to IMDb via OMDb; automatic source IDs come from Wikidata, which receives public Netflix IDs but never your API key. Public Netflix film metadata is requested without account cookies or the OMDb key, and cached for 30 days. Public distribution needs provider-rights and product-name checks.

After reloading or updating the extension in Chrome, refresh the Netflix tab too. A disconnected script stops and offers **Refresh Netflix**; it does not reload a playing page automatically. Chrome may retain older warning entries under Errors until you clear them.
