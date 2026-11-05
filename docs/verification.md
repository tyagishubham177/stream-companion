# Stream Companion v1 verification

Verified on 5 November 2026 with Node.js 24.14.0, Windows PowerShell, TypeScript 5.9 and Playwright Chromium 156.0.8078.4. Extension version: 0.1.0.

## Results

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 120 tests passed across five files |
| `npm run build` | Passed; locally bundled MV3 extension |
| `npm run test:browser` | Six actual MV3 integration tests passed |
| Dependency audit | Zero reported vulnerabilities after locked dependency installation |
| Archive creation and readback | Passed; 14 files, manifest and required entrypoints present |
| `git diff --check` | Passed |
| Screenshot review | Desktop settings/correction/badges and narrow settings reviewed |

Unit coverage includes title/type/year evidence, Unicode and sequel identity, URL/message authorization, malformed and interrupted provider responses, absent scores, persistent reservations and circuits, conservative clock handling, correction/reset races, bounded retries, live demand cancellation, priority promotion, trusted storage and concurrent configuration mutations. Forty-six freshness cases cover weekly/monthly selection, ongoing/completed series, UTC year boundaries, exact expiry/stale-grace boundaries and invalid timestamps. A separate resolver case verifies fresh preview reuse and an explicit key-test bypass.

The MV3 suite launches the built extension in a disposable persistent profile. It verifies key setup through the real service worker, provider request accounting, explicit correction preview/confirmation, duplicate-card fanout, fresh cache reuse after reload, keyboard focus/dismissal, card recycling, enable/disable, SPA playback teardown, cache clearing without loss of mappings/usage/cooldown, blocked malformed commands, browser/worker restart persistence, narrow settings, 200% CSS zoom and forced-colour/reduced-motion usability. An aged-cache scenario proves that an older movie's 20-day cache and a recent movie's six-day cache make no request, while eight-day recent and 31-day older snapshots each refresh once across duplicate cards. The profile is removed after the suite.

Test provider responses use explicitly synthetic titles and a fake key. Network routing plus loopback DNS isolation prevents fixture work from reaching real OMDb/Netflix accounts. Browser test data is not compiled into the production extension. Tests do not establish provider response freshness or real catalogue precision.

## Live evidence and remaining acceptance

The extension was installed in the user's normal Chrome profile on 5 November 2026. A personal free OMDb key was generated and activated; the user saved it in Settings and reported a successful connection test. Browser automation could operate Netflix but explicitly could not access the `chrome-extension://` settings/correction pages. No account/session export was made, and no API key is stored in this repository or its screenshots.

| Live check | Observed result |
|---|---|
| Home | Modern browse cards received setup badges before configuration, then match-needed states after configuration |
| Search | `/search?q=Far%20and%20Away` rendered rating/status badges |
| Automatic movie identity | Opening the normal movie detail panel supplied title, explicit movie label, runtime and 1992 release year; no private Netflix API was used |
| Real provider result | Far and Away (1992), IMDb `tt0104231`, score 6.6/10, 73,532 votes in the fetched OMDb response |
| Freshness | Details showed a 30-day interval for this older movie |
| Persistence/cache | After a full reload and later navigation back to Search, details retained the exact fetched time, `05/11/2026, 11:45:29` (local browser display), demonstrating reuse of the stored snapshot |
| Keyboard | Enter opened rating details; Escape dismissed them and returned focus to the badge |
| Playback separation | Tested badge interactions left the URL on Search rather than navigating to `/watch/` |
| My List | 44 recognized cards, 44 badge elements and one overlay host; 10 badges visible in the inspected viewport |
| Scrolling | At scroll position 600 CSS px, all 10 visible badges stayed inside the viewport and aligned with the matching underlying title; one overlay host remained |

The live sample validates one numeric title and selected browse mechanics. It does not establish catalogue-wide automatic coverage or precision. Many cards intentionally show `IMDb ?` when Netflix exposes insufficient identity evidence. Manual correction/confirmation, settings toggles/cache clearing, browser restart and quota handling were verified in isolated MV3 fixtures; their equivalent live-profile actions were not all repeated because extension pages are blocked to browser control. Browser-native zoom, full playback-state teardown and the labelled 100-title catalogue gate remain open. No test deliberately started title playback.

The unchanged fetched timestamp supports cache reuse; production provider request logs were not captured because request URLs contain credentials. Performance targets such as p95 cached latency, DOM long tasks, memory stability and catalogue-wide automatic coverage have not been measured. The package remains a local v1 candidate rather than a public-store release. The original input design remains untouched.

![Stream Companion displaying a real IMDb rating on Netflix Search](images/netflix-live-rating.jpg)

## Screenshots

The following captures are from the actual built extension in isolated browser fixtures. Their displayed title scores are synthetic; the live Netflix capture above uses the real provider response.

![Stream Companion ratings on synthetic browse cards](images/badges.png)

![Stream Companion title correction in the MV3 fixture](images/correction.png)

![Stream Companion settings](images/settings.png)

## Continuity

Product name: Stream Companion. Ratings is the first feature, Netflix the first adapter, IMDb the rating source, OMDb the data provider. Keep platform title mappings separate and preserve source/provider namespaces when adding capabilities. Prefer additional verified adapters and ordinary bundled modules over a runtime plugin system.

Development branch: `feat/streaming-ratings-v1`. This is a new local repository in its own folder; the parent workspace and existing extensions were not modified. No remote is configured, so there is no push destination. Final source and documentation are committed locally.
