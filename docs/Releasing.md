# Versioning and releases

Repository: [tyagishubham177/stream-companion](https://github.com/tyagishubham177/stream-companion). The repository is public. `main` is the default branch; feature branches hold ongoing work.

Use semantic versions: patch for compatible fixes, minor for compatible features, and major for breaking changes. Keep `package.json`, the root package entry in `package-lock.json`, and `public/manifest.json` aligned. Update the renderer marker when needed to identify a new content build, the changelog, and verification evidence. Schema, resolver, adapter and message protocol versions change independently when their corresponding contracts require it.

Historical annotated tags v0.1.0 through v0.3.1 identify the final available snapshots for those manifest versions. They do not claim retrospectively rebuilt or retested binaries. v0.4.0 includes the matching-log feature, repository handoff documentation and the verified installable ZIP.

## Prepare a release

Start from the latest `main` in a clean checkout and create a release branch. Implement the version/changelog changes, then run:

```powershell
Set-Location 'D:\Coding Projects\chrome extensions\stream-companion'
npm ci
npm run check
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) 'node_modules\.cache\ms-playwright'
npx playwright install chromium
npm run test:browser
node scripts/package.mjs
git diff --check
```

Review the ZIP's manifest and required entrypoints. It must contain only the built extension, with no credentials, browser profiles, test helpers or logs. Build output and ZIPs stay ignored in Git; attach the ZIP to the GitHub release. Record verification honestly and retain the distinction between synthetic tests and installed Netflix checks.

Commit and push the release branch, review/merge it into `main`, then tag the exact release commit. For a future version, replace the example version and file paths below. Do not move an existing published tag; issue a new patch version instead.

```powershell
git switch main
git pull --ff-only origin main
git tag -a v0.4.1 -m 'Stream Companion v0.4.1'
git push origin main
git push origin v0.4.1
gh release create v0.4.1 '.\releases\stream-companion-0.4.1.zip' --verify-tag --title 'Stream Companion v0.4.1' --notes-file '.\release-notes.md'
```

Prepare the specified release notes file before using the last command, or point it at a reviewed existing document. Publishing is manual; no credentials or automated publishing workflow are stored in this repository. Verify the repository's default branch, tag commit and release asset after publishing.
