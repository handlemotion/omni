# 0051: Releases run on GitHub, cut by release-please

Date: 2026-11-19 · Status: accepted · Amends: docs/spec/desktop.md ("Build, signing, release")

## Context

Desktop and iOS releases ran on Rodrigo's Mac: `apps/desktop/scripts/release-macos.sh` and
`apps/ios/scripts/release-testflight.sh`, with every key a file on that Mac. Each release needed
the Mac awake, his approval in a Remote Control thread, and a hand-raised version and build number.
The spec chose this because CI had no budget for signed builds. Since PR 550 every job runs on
GitHub-hosted runners paid from the Enterprise plan's included usage, where a macOS minute costs
about ten Linux ones (docs/operations/ci-runners.md); one release of each app is roughly 45 macOS
minutes, which the plan covers many times a month.

Pull request titles were free-form ("iOS: a swiped conversation fills ..."), so nothing could tell
a fix from a feature or write a changelog.

## Decision

1. **Pull request titles are Conventional Commits** (`feat(ios): ...`, `fix(desktop): ...`).
   Squash merge makes the title the commit on main. `pr-title.yml` checks it on every pull request.
2. **release-please cuts versions** (`release.yml`, `release-please-config.json`). It keeps one
   release pull request open with the next version and changelog of each app the merged commits
   touched: `apps/desktop` (package.json and `tauri.conf.json`) and `apps/ios` (package.json, read
   by `app.config.ts`). `feat` raises the minor version, `fix` and `perf` the patch, `!` the major.
   Nothing ships until someone merges it.
3. **Merging the release pull request builds and publishes on GitHub.** It tags `desktop-vX.Y.Z`
   and `ios-vX.Y.Z`; `desktop-release.yml` runs the same `release-macos.sh` on `macos-15` and
   `ios-release.yml` runs the same `release-testflight.sh` on `macos-26`. Keys are secrets of the
   Doppler config `prd_github`, synced to the GitHub environment `production`
   (docs/operations/releases.md), and written to files for the job only.
   The scripts still run on a Mac by hand, unchanged in what they need.
4. **iOS signs by hand on CI.** With an App Store Connect key and an Apple Distribution certificate
   in the keychain, `app.config.ts` signs only the app target with that certificate and the app's
   App Store profile, so a fresh runner needs no development certificate. The build number is one
   above the highest App Store Connect holds.
5. **The web app, Worker and mail service carry no version.** They deploy on every merge to main.

## Consequences

- A release is one merge from any device. The Mac is no longer needed for it.
- Pull requests and tags made with the default `GITHUB_TOKEN` start no workflows, so `Checks`
  does not run on the release pull request by itself unless `RELEASE_PLEASE_TOKEN` is set; it can
  be started by hand on that branch.
- A `desktop-v*` tag no longer builds an unsigned macOS app in `desktop.yml`: the signed release
  build replaces it. Windows still compiles on a tag.
- Losing those secrets stops releases, not the apps; the originals stay in
  the team's Apple account and on the Mac.
