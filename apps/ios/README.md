# @omni/ios

The iOS app: Expo and Expo Router on `@omni/client`, the same typed client the web app uses.
Rules: `AGENTS.md`.

## Run it

```bash
pnpm stack:up && pnpm stack:serve        # the Worker on :8787
cp apps/ios/.env.example apps/ios/.env   # EXPO_PUBLIC_OMNI_API_URL: the Worker's origin
pnpm --filter @omni/ios dev              # Expo; open in Expo Go or a development build
```

A phone can't reach `localhost`: point `EXPO_PUBLIC_OMNI_API_URL` at a URL it can reach. The Worker must trust the app's scheme for sign-in: add `omni://` (and `exp://` for Expo
Go) to `AUTH_TRUSTED_ORIGINS`. Continue opens the server's `/login` in a browser sheet; Google
returns to the app from the sheet, and a magic link opens in Safari and returns to the app.

## Live preview on a Mac

```bash
pnpm ios:dev             # Simulator, Metro hot reload
pnpm ios:dev --device    # a plugged-in iPhone, same Metro
pnpm ios:dev --metro     # skip the native check/build, just start Metro
pnpm ios:dev --rebuild   # force a native rebuild
```

`scripts/dev.sh` builds a Debug development build ("Omni Dev", bundle id
`app.omnidirectional.ios.dev`, set with `OMNI_IOS_DEV_BUNDLE_ID`), installs it and starts Metro;
saving a file reloads the app. It fingerprints native inputs with `@expo/fingerprint` and caches
build stamps per Simulator/iPhone in `~/.cache/omni-ios/`, so reruns across worktrees and on a
physical iPhone reuse the installed build and only rebuild when native config or native
dependencies change.
The API is `EXPO_PUBLIC_OMNI_API_URL` from `.env`: `http://localhost:8787` for the local stack,
`https://omnidirectional.app` for real data. Screenshot the Simulator with
`xcrun simctl io booted screenshot shot.png`.

On an iPhone: Developer Mode on, the phone on the Mac's Wi-Fi (Metro listens on every interface),
and `OMNI_IOS_TEAM_ID` set so Xcode signs the dev build. A phone can't reach `localhost`, so
point the API at production.

## Check it without a Mac

- `pnpm --filter @omni/ios build:check` bundles the app for iOS with Metro (Hermes bytecode): it
  fails on anything that would not compile or resolve on a phone.
- `pnpm check-types` covers the app with the rest of the repo.
- `npx expo export --platform web` renders the same screens in a browser, for screenshots at
  phone size. Serve it on a trusted origin with `/api` forwarded to the Worker so sign-in works.

## Release to TestFlight

Releases are cut by release-please and built by the `iOS release` workflow
(`docs/operations/releases.md`): merge the release pull request and the build reaches TestFlight.
By hand, on a Mac with Xcode signed in to the Apple account that owns the team, and the app created in App
Store Connect under the same bundle ID:

```bash
EXPO_PUBLIC_OMNI_API_URL=https://<your-worker-origin> \
OMNI_IOS_BUNDLE_ID=<bundle id> OMNI_IOS_TEAM_ID=<team id> OMNI_IOS_BUILD_NUMBER=<n> \
  apps/ios/scripts/release-testflight.sh
```

It prebuilds the native project, archives a Release build, and uploads it (`UPLOAD=0` exports the
`.ipa` to `apps/ios/ios/build/release` instead). The Worker must list the app's scheme
(`omni://`) in `AUTH_TRUSTED_ORIGINS`, or sign-in links can't return to the app. CocoaPods must be
installed (`brew install cocoapods`). With an App Store Connect key (`ASC_KEY_PATH`, `ASC_KEY_ID`,
`ASC_ISSUER_ID`) the build number may be left out: it is asked of App Store Connect.

## Over-the-air updates (EAS Update)

Optional. When `OMNI_IOS_EAS_PROJECT_ID` is unset, `expo-updates` is disabled so self-hosters need
no Expo account. When set, builds gate updates by native fingerprint
(`runtimeVersion: { policy: "fingerprint" }` with `fingerprint.config.js`), so native changes still
go through a full TestFlight build while JS/TS/UI changes ship in ~30 seconds:

- **TestFlight (`production` channel):** every push to `main` touching `apps/ios` or its shared
  packages runs `.github/workflows/ios-update.yml` on Linux and publishes to the `production` branch.
  Testers receive the update on their next app launch.
- **Branch previews in Omni Dev:** publish an update for any branch and open it from the
  **Extensions** tab inside **Omni Dev** (no laptop or Wi-Fi required):

```bash
cd apps/ios
OMNI_IOS_EAS_PROJECT_ID=<project id> npx --yes eas-cli@latest update --branch <branch> --environment preview --platform ios
```

Check rollout health and crash rates with `eas update:insights` and `eas channel:insights`.
