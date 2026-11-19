# @omni/ios

The iOS app: Expo and Expo Router on `@omni/client`, the same typed client the web app uses.
Rules: `AGENTS.md`.

## Run it

```bash
pnpm stack:up && pnpm stack:serve        # the Worker on :8787
cp apps/ios/.env.example apps/ios/.env   # EXPO_PUBLIC_OMNI_API_URL: the Worker's origin
pnpm --filter @omni/ios dev              # Expo; open in Expo Go or a development build
```

A phone can't reach `localhost`: point `EXPO_PUBLIC_OMNI_API_URL` at the HTTPS URL `pnpm share`
prints. The Worker must trust the app's scheme for sign-in: add `omni://` (and `exp://` for Expo
Go) to `AUTH_TRUSTED_ORIGINS`. Continue opens the server's `/login` in a browser sheet; Google
returns to the app from the sheet, and a magic link opens in Safari and returns to the app.

## Check it without a Mac

- `pnpm --filter @omni/ios build:check` bundles the app for iOS with Metro (Hermes bytecode): it
  fails on anything that would not compile or resolve on a phone.
- `pnpm check-types` covers the app with the rest of the repo.
- `npx expo export --platform web` renders the same screens in a browser, for screenshots at
  phone size. Serve it on a trusted origin with `/api` forwarded to the Worker so sign-in works.

## Release to TestFlight

On a Mac with Xcode signed in to the Apple account that owns the team, and the app created in App
Store Connect under the same bundle ID:

```bash
EXPO_PUBLIC_OMNI_API_URL=https://<your-worker-origin> \
OMNI_IOS_BUNDLE_ID=<bundle id> OMNI_IOS_TEAM_ID=<team id> OMNI_IOS_BUILD_NUMBER=<n> \
  apps/ios/scripts/release-testflight.sh
```

It prebuilds the native project, archives a Release build, and uploads it (`UPLOAD=0` exports the
`.ipa` to `apps/ios/ios/build/release` instead). The Worker must list the app's scheme
(`omni://`) in `AUTH_TRUSTED_ORIGINS`, or sign-in links can't return to the app. CocoaPods must be
installed (`brew install cocoapods`).
