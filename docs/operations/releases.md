# Releases

Desktop and iOS releases are cut by release-please and built on GitHub.

## Shipping a release

1. Merge pull requests with Conventional Commit titles (`feat(ios): ...`, `fix(desktop): ...`).
   `PR title` fails on any other title.
2. `Release` keeps one pull request open, "chore(main): release main", with the next version and
   changelog of every app the merged work touched. Review it like any pull request.
3. Merge it. That tags `desktop-vX.Y.Z` and `ios-vX.Y.Z` for the raised apps, makes their GitHub
   releases, and starts `Desktop release` (macOS signed and notarized, and Windows, both on their
   update feeds in about 25 minutes) and `iOS release` (in TestFlight once Apple finishes processing).

To retry or rebuild a tag: Actions, `Desktop release` or `iOS release`, Run workflow, with the tag.
To pick a version yourself, put `Release-As: 1.0.0` in the body of a commit to main.

## Settings: Doppler `prd_github`

The release jobs run in the GitHub environment `production`, which Doppler's GitHub sync fills from
the `prd_github` config. Add or change a value in Doppler, never in GitHub. All of them arrive as
secrets, plain config included. `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (needs Workers R2
Storage edit) and `OMNI_DESKTOP_UPDATER_KEY` are already there.

| Name                                                                                            | What                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_TEAM_ID`                                                                                 | The Apple team that signs both apps.                                                                                                                                                |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`                                                                   | The App Store Connect API key's ID and issuer ID.                                                                                                                                   |
| `ASC_API_KEY_P8`                                                                                | That key's `.p8` file, as text (Admin role: it makes the iOS App Store profile).                                                                                                    |
| `IOS_DISTRIBUTION_P12_BASE64`                                                                   | The Apple Distribution certificate with its private key, exported as `.p12`, then `base64 -i cert.p12`                                                                              |
| `IOS_DISTRIBUTION_P12_PASSWORD`                                                                 | The password that `.p12` was exported with.                                                                                                                                         |
| `DEVELOPER_ID_P12_BASE64`                                                                       | The Developer ID Application certificate with its private key, as `.p12`, base64.                                                                                                   |
| `DEVELOPER_ID_P12_PASSWORD`                                                                     | Its export password.                                                                                                                                                                |
| `DESKTOP_SIGNING_IDENTITY`                                                                      | `APPLE_SIGNING_IDENTITY` from `apps/desktop/.env`.                                                                                                                                  |
| `DESKTOP_APP_PROFILE_BASE64`                                                                    | The file `OMNI_APP_PROFILE` names in `apps/desktop/.env`, base64.                                                                                                                   |
| `DESKTOP_EXTENSION_PROFILE_BASE64`                                                              | The file `OMNI_EXTENSION_PROFILE` names, base64.                                                                                                                                    |
| `OMNI_DESKTOP_UPDATER_KEY`                                                                      | The updater's private key (the file `TAURI_SIGNING_PRIVATE_KEY_PATH` names), as text.                                                                                               |
| `DESKTOP_UPDATER_KEY_PASSWORD`                                                                  | Its password, if it has one.                                                                                                                                                        |
| `DESKTOP_UPDATER_PUBKEY`                                                                        | The contents of `<TAURI_SIGNING_PRIVATE_KEY_PATH>.pub`.                                                                                                                             |
| `OMNI_DESKTOP_ORIGIN`                                                                           | The server releases are served from, e.g. `https://omnidirectional.app`.                                                                                                            |
| `EXPO_PUBLIC_OMNI_API_URL`                                                                      | The origin the iOS app talks to, e.g. `https://omnidirectional.app`.                                                                                                                |
| `OMNI_IOS_BUNDLE_ID`                                                                            | The iOS app's bundle ID in App Store Connect.                                                                                                                                       |
| `OMNI_IOS_NAME`, `OMNI_IOS_SCHEME`                                                              | Optional; the app's name under its icon (default `Omni`) and URL scheme (default `omni`).                                                                                           |
| `OMNI_DESKTOP_BUNDLE_ID`, `OMNI_DESKTOP_APP_GROUP`, `OMNI_DESKTOP_RELEASE_BUCKET`               | Optional; defaults `app.omnidirectional.desktop`, `group.<bundle id>`, `omni-desktop`.                                                                                              |
| `OMNI_WINDOWS_SIGNING_ENDPOINT`, `OMNI_WINDOWS_SIGNING_ACCOUNT`, `OMNI_WINDOWS_SIGNING_PROFILE` | Optional; Azure Trusted Signing's endpoint, account and certificate profile for the Windows installer. Unset, Windows releases ship unsigned (SmartScreen warns on first download). |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`                                     | With the above: the service principal allowed to sign with that profile ("Trusted Signing Certificate Profile Signer" role).                                                        |
| `EXPO_PUBLIC_SENTRY_DSN`, `OMNI_DESKTOP_SENTRY_DSN`                                             | Optional; the Sentry DSNs of the iOS app and the Mac sync extension. Unset leaves crash reporting off.                                                                              |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_IOS_PROJECT`                                         | Optional; upload the iOS build's source maps and debug symbols to Sentry.                                                                                                           |
| `OMNI_IOS_LINK_HOST`                                                                            | Optional; the host whose share links open in the iOS app (Associated Domains). Set the Worker's `IOS_APP_IDS` and enable Associated Domains on the App ID first.                    |

`RELEASE_PLEASE_TOKEN` is a repository secret, optional: a fine-grained token on this repository
with Contents and Pull requests read and write. With it, `Checks` runs on the release pull request
by itself and release tags start workflows.

## Cost

Both release jobs run on macOS, billed at about ten Linux minutes each (docs/operations/ci-runners.md):
about 25 minutes for the desktop app and 20 for iOS. The desktop release also runs about 20
minutes on Windows, billed at about two Linux ones. Nothing else in `Release` uses macOS; the
release pull request job takes seconds on Linux.
