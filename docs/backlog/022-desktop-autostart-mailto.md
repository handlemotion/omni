# Desktop: Launch at login is forced on, and mailto links leave Omni

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Desktop + web                                |
| Who      | Needs Rodrigo: settings row                  |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/desktop/src-tauri/src/startup.rs:1-3`, `server.rs:37-39`
- `apps/desktop/src-tauri/tauri.conf.json:33` (only `omni` scheme)
- `apps/desktop/src-tauri/src/navigation.rs:54`, `apps/web/src/lib/desktop.ts` (`OUTSIDE`, `onLinkClick`)
- `docs/spec/desktop.md:231,236`

## Problem

Every desktop user is enrolled in launch at login with no way to turn it off in Omni (the autostart permissions are granted but nothing calls them). The spec's `mailto:` handler doesn't exist, and clicking an address inside Omni opens Apple Mail.

## Evidence

Read from the code and Tauri config.

## Fix

Add `@tauri-apps/plugin-autostart`, `desktop.autostart.{get,set}` in the bridge, and a toggle shown only on desktop. Catch same-window `mailto:` clicks in web and open the compose route; register the scheme in Tauri and route it through `deep_link.rs`.

## Done when

In the desktop app: toggle off, relaunch the Mac, Omni stays closed; click an address and Omni's composer opens.

## Notes

Not the Drive sync or iOS parity work other threads own.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
