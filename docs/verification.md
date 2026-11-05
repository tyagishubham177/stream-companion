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

The real logged-in Netflix browse markup and one naturally opened series/movie detail layout were inspected. This supplied selector and evidence provenance, including the important distinction between a series start year and a displayed season year. No account/session export was made.

The extension has not been installed into the user's normal Chrome profile. No real OMDb key was supplied or tested. Live injected badge interactions, Netflix search/My List layouts, browser-native zoom, playback separation and the 100-title labelled catalogue gate remain open. Those require the installation and verification steps in `README.md`; they are not implied by fixture success.

Performance targets such as p95 cached latency, DOM long tasks, memory stability and catalogue-wide automatic coverage have not been measured. The package is a local v1 candidate, not a public-store release. The original input design remains untouched.

## Screenshots

These are captures from the actual built extension in isolated browser fixtures. All displayed title scores are synthetic.

![Stream Companion ratings on synthetic browse cards](images/badges.png)

![Stream Companion title correction in the MV3 fixture](images/correction.png)

![Stream Companion settings](images/settings.png)

## Continuity

Product name: Stream Companion. Ratings is the first feature, Netflix the first adapter, IMDb the rating source, OMDb the data provider. Keep platform title mappings separate and preserve source/provider namespaces when adding capabilities. Prefer additional verified adapters and ordinary bundled modules over a runtime plugin system.

Development branch: `feat/streaming-ratings-v1`. This is a new local repository in its own folder; the parent workspace and existing extensions were not modified. No remote is configured, so there is no push destination. Final source and documentation are committed locally.
