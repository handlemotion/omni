# 0043: A desktop app on Tauri, and Drive as a File Provider

Date: 2026-11-16 · Status: proposed · Amends: spec v1 (clients: web and iOS only), ADR 0034
("Not in v1": realtime list updates; files are never replaced in place), AGENTS.md
("TypeScript monorepo")

## Context

The founder asked on 2026-11-16 for a desktop app, the same as the web app, fast and native in
feel, on macOS and Windows, with a Dropbox-style folder in `~/Library/CloudStorage` that syncs
with the Drive module. Nothing desktop exists in the repo. The full design is
`docs/spec/desktop.md`; this records the choices that are hard to undo.

## Decision

1. **Tauri 2, not Electron** (founder's choice): smaller, lighter, the system's webview. We accept
   WebKit on macOS as a supported engine for `apps/web`, and Rust in the repo for the shell only.
2. **The window loads the Omni server's origin**; only a server picker and an offline screen are
   bundled. Tauri's default is bundled assets, and remote origins are a supported opt-in. A
   bundled web app would sit on `tauri://localhost`, where the session cookie is cross-site,
   passkeys cannot match the relying party, and relative `/api` URLs break; fixing each would
   fork the web app's data layer. The remote origin gets a minimal capability and no filesystem.
3. **Drive on the computer is the operating system's own mechanism**: a File Provider replicated
   extension on macOS (Swift), the Cloud Files API on Windows (Rust). One "Omni" folder with a
   folder per synced workspace inside it. A mirrored folder with a file watcher was offered and declined.
4. **Storage gains a sync protocol**, additive: a per-workspace revision on every node,
   tombstones, a change feed, replacing a file's bytes in place guarded by its content version,
   and a `storage.changed` realtime event. Conflicts are decided by version on the server and
   resolved by keeping both files.
5. **Sync authenticates with OAuth, not the session**: the provider from ADR 0029, a first-party
   "Omni Desktop" client and a `storage:sync` scope, tokens in the system keychain. One grant
   covers all of the person's workspaces, so sync routes name the workspace in the path.
6. **Swift and Rust types are generated from `@omni/contracts`**; no response shape is written
   by hand in a second language.

## Consequences

- A Rust toolchain and a Swift package enter the repo, with their own `Desktop` CI workflow on
  macOS and Windows runners. `Checks` does not change for other work.
- `scripts/check-tests.mjs` governs TypeScript tests only. Rust tests in `apps/desktop` follow the
  same rule in spirit: pure logic only, named for the bug they catch.
- The File Provider cannot be built, signed or run in a cloud session. It ships with a manual
  checklist run on a real Mac, reported in its PR; that is evidence, a green compile is not.
- Shipping needs an Apple Developer team and a Windows signing identity, set up by a founder.
- Replacing bytes in place means a bad sync client can destroy content, not only add it. Every
  replace carries the version it read; file versions (history) become the natural next step.
- An installed desktop shell is long-lived. The `omni://` scheme, the bundle identifier, the app
  group and the `/sync` routes are public surface from the first release.

## Amendment 1 (2026-11-16): the app's macOS sync work is a Swift helper

The spec had Rust register the File Provider domain with `objc2-file-provider` and keep the sync
token with the `keyring` crate. Building it showed two problems: `apps/desktop` forbids `unsafe`
Rust, which every `objc2` call needs, and `keyring` writes to the login keychain, not the keychain
access group the sandboxed extension reads. The founder chose the alternative:

- `omni-sync`, a Swift command-line helper in `Contents/MacOS/`, registers and removes the domain,
  runs the sync sign-in (PKCE), writes `sync.json` (server, workspaces on, paused) in the App
  Group container, and signals the working set. The Tauri shell runs it for each sync command
  and reads one line of JSON (types from `@omni/contracts`). Its main bundle is the app, so
  `NSFileProviderManager` finds the embedded extension.
- The helper claims no entitlement. A signed run showed macOS kills a bare tool that claims a
  restricted one (`keychain-access-groups`): only a bundle's main executable gets the bundle's
  provisioning profile. So the app, which holds the profile, keeps the sync token in the shared
  keychain group with the `security-framework` crate (safe Rust; no `unsafe` in our code), and
  the extension reads and refreshes it there.
- The extension and helper are built by SwiftPM and a script, not an Xcode project.
