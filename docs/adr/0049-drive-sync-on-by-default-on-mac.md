# 0049: Drive sync turns on by itself the first time the Mac app runs

Date: 2026-11-19 · Status: accepted · Amends: ADR 0043 (desktop app and Drive sync), `docs/spec/desktop.md` ("Sync is off until switched on")

## Context

The spec kept Drive sync off until the person switched a workspace on in Settings → Drive,
because it puts a folder in Finder. In practice nothing in the app leads there: the founder ran
the Mac app for days, with the File Provider extension installed, signed and registered, and
never got an Omni folder, because he never found the switch. People install a desktop app with
Drive sync to get the folder; Dropbox, iCloud Drive and Google Drive all create theirs on first
run.

## Decision

1. **The first time the Mac app runs signed in, every workspace the person belongs to is switched
   on.** Without a sync grant yet, the first switch sends the window through the sync sign-in
   (the first-party `omni-desktop` client, no consent screen) and back; the rest follow on
   return.
2. **It happens once per computer.** The web app keeps the setup's phase in the app window's
   local storage (`omni.desktop-sync-setup`), so a workspace switched off later stays off. A
   computer where any workspace is already on is left as it is.
3. **A failed or cancelled sign-in ends setup** rather than sending the window back to it; the
   switches in Settings → Drive still work as before.
4. **The web app does it, not the shell.** The Mac app loads the server's web app, so the change
   reaches installed apps on reload without a desktop release.

## Consequences

- New workspaces joined later are not switched on by themselves; that stays a switch in
  Settings → Drive.
- Clearing the app window's storage (or reinstalling into a fresh profile) runs setup again, and
  it switches workspaces on only if none is on.
