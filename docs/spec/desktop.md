# Omni Desktop: the app in a native window, and Drive in Finder

Nov 16, 2026 · Draft for review · Extends `docs/spec/v1.md`

## Summary

Omni gets a desktop app for macOS and Windows. It is two things in one install:

1. **The app.** The web app, unchanged, in a native window: its own Dock icon, a title bar that
   holds navigation, native notifications, deep links, auto-update. Built on Tauri 2.
2. **Drive on the computer.** Storage shows up as one folder the operating system owns,
   `~/Library/CloudStorage/Omni` on macOS, "Omni" in Finder's sidebar, with a folder inside for
   each synced workspace and files that download when opened and upload when saved. This is a macOS File Provider extension. Windows
   gets the same through the Cloud Files API, one layer later.

No screen is rebuilt. The window loads the same `apps/web` build the browser gets, so a web
deploy updates the desktop app's UI too. What is new is a thin native shell, a sync protocol on
the Storage API, and the two operating-system sync providers that speak it.

Decided by the founder on Nov 16, 2026: Tauri 2 over Electron; a real File Provider from the
start, not a mirrored folder; avoid duplicating the web app; small navigation changes only.

## Goals and non-goals

**Goals**

- One codebase for the UI. A change in `apps/web` reaches browser and desktop in the same deploy.
- Drive files in Finder behave like Dropbox's or iCloud's: on demand, status badges, "Download
  now", "Remove download", edits sync both ways, usable offline for files kept on the computer.
- Windows from the first release of the shell; Windows file sync one layer after macOS.
- Self-hostable: the app asks which Omni server to use. Nothing Handlemotion-specific in code:
  server origin, bundle identifier, team id and app group are build config.
- Sync holds no session cookie. It has its own revocable credential, scoped to Storage.

**Non-goals for this version**

- Offline mail, or any offline use of the app window. Without a connection the window shows one
  local screen and the Finder folder keeps working for downloaded files.
- Linux. Tauri builds there, and we use that to check the shell in CI, but we ship no package.
- Mac App Store and Microsoft Store. Direct download, signed and notarized.
- File version history, selective sync by folder, "Shared with me" in Finder, LAN sync.
- Tabs in the title bar (see "Open questions").

## Decisions and why

### 1. Tauri 2

Chosen by the founder for size, memory and start time. What it costs us, so the plan pays for it:

- **The webview is the system's**: WebKit on macOS, WebView2 (Chromium) on Windows. `apps/web`
  must work in Safari already; the desktop app makes that a hard requirement. The web e2e gains a
  WebKit run of the smoke path.
- **A second language.** The shell is Rust. It stays small: windows, deep links, tray, updater,
  keychain, and telling the sync provider that something changed. No product logic.
- **Tauri does not bundle or sign app extensions.** We build and sign the File Provider extension
  ourselves and let Tauri copy it in (see "Build, signing, release").

### 2. The window loads the server's web app

Tauri's default is to bundle the frontend and serve it from `tauri://localhost`; loading a remote
origin is supported and opt-in (`remote.urls` on a capability). We bundle a small local shell and
load the Omni server's own origin in the main window. Bundling the whole web app was rejected
because it is the incorrect option for this app, not because it is harder:

| Needs                                              | Bundled at `tauri://localhost`                                                 | Server origin in the window |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| Session cookie (Better Auth, httpOnly)             | Cross-site: WebKit drops it. Needs a second HTTP stack (Rust) with its own jar | First-party, unchanged      |
| Realtime websocket, `<img src="/api/image-proxy">` | Not covered by that second stack: no session                                   | Unchanged                   |
| Relative `/api/...` links in stored mail HTML      | Resolve against `tauri://`: broken                                             | Unchanged                   |
| Passkeys (RP ID is the server's domain)            | Origin mismatch: impossible                                                    | Possible (decision 5)       |
| Stripe, Google connect, OAuth consent redirects    | Each needs the app's origin allow-listed                                       | Unchanged                   |
| Old client against new API (AGENTS.md, "Database") | A desktop release per UI change, and installed old versions forever            | Same as a browser tab       |

What stays bundled is `apps/desktop/src`: a server picker for the first run and for self-hosters,
an offline screen, and nothing else. It never talks to `/api`.

The remote origin gets the smallest capability that works: window dragging and controls,
back/forward, notifications, badge count, opening external links, and three commands of ours
(`sync_status`, `sync_connect`, `sync_disconnect`). No filesystem, no shell, no HTTP plugin. Only
the configured server origin matches `remote.urls`, so another origin's page or frame in the window
can call nothing. Link clicks to other origins and new windows open in the default browser (the
web app sends them there on purpose); the app's own round trips through another origin (Google
connect, Stripe, Domain Connect) and third-party frames (Stripe Elements) stay in the window,
because their state and cookies live in its cookie jar.

### 3. Drive is one File Provider domain, a folder per workspace

- macOS: an `NSFileProviderReplicatedExtension` in Swift, embedded in the app. The system owns
  the folder, its on-disk state and the Finder UI; we answer four questions: what is in this
  folder, what changed since this anchor, give me this file's bytes, here is a change the person
  made.
- **One domain, "Omni"**, one entry in Finder's sidebar. Its root holds a folder per workspace
  the person turned sync on for, named after the workspace; each holds `My files` and, in a
  company, `Shared`. Those top two levels are made up by the provider, not Storage nodes: they
  cannot be renamed, moved or deleted in Finder, and nothing can be dropped beside them. Storage's
  access rules are unchanged: the server decides.
- A move between two workspaces' folders is refused, as in the app ("Not in v1");
  Finder then offers a copy, which is an upload to the other workspace.
- Windows: one sync root, "Omni", with the same layout, through the Cloud Files API, in Rust, in
  its own process. The `cloud-filter` crate is the starting point; it calls itself experimental,
  so the layer starts with a spike and falls back to the `windows` crate's raw bindings if it
  does not hold.
- The extension is the "microservice": the operating system starts it on demand, it runs with no
  window, and it holds no state of its own beyond what the system keeps for it. The Tauri app
  only registers the domain, signs in, and pokes it when the server says something changed.

### 4. One sync protocol, generated types

Both providers speak the same handful of Storage routes (below). Their request and response
shapes are zod schemas in `@omni/contracts`, as for every other client. A script turns those
schemas into JSON Schema (`z.toJSONSchema`) and quicktype turns that into Swift `Codable` and
Rust `serde` types, checked in and verified fresh by `pnpm check`. Nobody hand-writes a response
shape in Swift or Rust.

### 5. Signing in

- **The window** signs in like the browser. A magic link opens in the default browser, so the
  desktop app asks for it with its own scheme as the callback, exactly as iOS does
  (`apps/ios/src/lib/session.ts`, Better Auth's `expo` plugin already on the server): the Worker
  redirects to `omni://…?cookie=…`, the app receives the deep link and sets the cookie in the
  webview's store for the server origin. `omni://` joins `AUTH_TRUSTED_ORIGINS`.
- **Passkeys**: Windows works in WebView2. macOS needs the associated-domains entitlement
  (`webcredentials:<rp id>`) and the `apple-app-site-association` file the web app serves.
  Reports of it working in Tauri are mixed, so it is tried in the signing layer and the passkey
  button is hidden on macOS desktop until proven. Magic link always works.
- **Sync** never sees the cookie. It uses the OAuth 2.1 server Omni already runs for MCP
 : a first-party public client "Omni Desktop" (PKCE, redirect `omni://oauth/callback`)
  and a new scope `storage:sync`. Turning sync on opens the authorize URL in the app window,
  where the person is already signed in. The grant covers every workspace the person belongs to
  (the provider's existing "all workspaces" reference, no `omni_workspace` claim), so one token
  serves the one domain; which workspaces actually sync is a switch per workspace, kept by the
  app. Membership is checked on every request, so leaving a workspace ends its sync at once.
  Access and refresh tokens live
  in the macOS Keychain under an access group the app and the extension share, and in Windows
  Credential Manager. Signing out, or revoking "Omni Desktop" in Settings, stops sync and removes
  the domain; files not yet uploaded are kept in a `Not uploaded` folder on the Desktop first.

## The sync protocol (Storage module, Worker)

All additive. Under `/api/storage/sync`, accepting a bearer token with `storage:sync`. A token
spans workspaces and has no "active workspace", so every route but the first names one:
`/api/storage/sync/:orgId/...`. The Worker resolves the person's member in that workspace (`404`
when they are not in it) and everything goes through `db.forMember(memberId).storage`.

### Data model changes (`packages/db/src/schema/storage.ts`)

| Change                                                           | Why                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage_nodes.revision` bigint                                  | Set from a per-workspace counter in the same transaction as every change to the row (create, rename, move, trash, restore, new content, lock). The counter row is locked by the write, so revisions commit in order and a feed never skips one.     |
| `storage_nodes.content_version` int                              | Goes up when a file's bytes are replaced. With `revision` it is File Provider's `itemVersion` (content, metadata).                                                                                                        |
| `storage_nodes.content_sha256` text, nullable                    | Sent by the client that uploaded, so a provider can tell "same bytes" without downloading. Null for files uploaded before this.                                                                                                                     |
| `storage_sync_state` (org_id, revision)                          | The counter. One row per workspace.                                                                                                                                                                                                                 |
| `storage_tombstones` (org_id, node_id, space, owner_member_id, revision) | A node that left a drive for good: deleted forever, purged from Trash, or moved to the other space. Kept 90 days, then swept by the daily cron.                                                                                             |

Existing rows get `revision` in a backfill migration step that is safe to run twice.

### Routes

| Route                                         | Does                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sync/drives`                            | Every workspace the person belongs to, with its name and its drives: `personal`, and `shared` in a company, each with its current revision.                                                                                                       |
| `GET /sync/:orgId/changes?space=&cursor=&limit=`     | Nodes of that drive with `revision > cursor`, in order, live and trashed, plus tombstones as `{ id, deleted: true }`. Answers `nextCursor` and `more`. No cursor: the whole drive, paged. A cursor older than tombstone retention: `410 cursor_expired`, and the provider re-enumerates. |
| `GET /sync/:orgId/nodes/:id`                       | One node, for the provider's item lookup.                                                                                                                                                                                                         |
| `POST /files/:id/versions` (`ifContentVersion`, `sha256`), then `POST /uploads/:id/complete?ifContentVersion=` | Replaces a file's bytes in place: on complete, the node keeps its id, name and sharing, takes the new object, and its `content_version` goes up; the old object is deleted after the row commits. A stale `ifContentVersion` answers `409 version_conflict` and stores nothing. |
| `PATCH /nodes/:id`, `DELETE /nodes/:id` gain `ifRevision` (optional) | The same guard for rename, move and trash. Without it they behave as today.                                                                                                                                             |
| `GET /files/:id/content`                      | Unchanged: its `ETag` is the stored object's (R2), which changes whenever the bytes do, and `If-Range` resumes against it. A provider that needs the version it downloaded reads the node before and after. |

The last three rows change the existing routes for every client. The folder, rename, move, trash,
upload and download routes are written once against a door (`apps/worker/src/storage/changes.ts`)
and already mounted twice; they are mounted a third time under `/sync/:orgId`, where the bearer
token picks the member. Rate limit: `RATE_LIMIT_STORAGE_SYNC`, per token.

### Realtime

The workspace's Durable Object gains `{ type: "storage.changed", space }`, sent after any commit
that bumps a revision. The Tauri shell holds one such websocket per synced workspace (bearer
token) while it runs and signals the provider; without the socket it polls `/sync/drives` every 60 seconds and compares
revisions. The web app can use the same event later to stop refetching lists on focus.

### Conflicts

The server is the judge, by version, never by clock.

- Edit on the computer, file changed on the server since: the upload answers `409`. The provider
  uploads the local bytes as a new file, `name (conflicted copy, <computer> <date>).ext`, beside
  the original, then takes the server's version. Nothing is overwritten or lost.
- Rename, move or delete of something changed on the server: refetch the node and let the system
  reapply or drop the change (File Provider's own rules).
- Delete on the computer is Trash on the server, 30 days, as in the app. A locked file
  answers `423`-style refusal today (`locked`); the provider marks the item read-only up front
  from `lockedAt`.
- Names the server numbers (`report (1).pdf`) come back in the answer and the provider adopts
  them. Case-only clashes cannot happen: sibling names are already unique ignoring case.
- A viewer role never reaches the provider in v1: only the member's own drives are synced.

### What the provider ignores

`.DS_Store`, `Thumbs.db`, `desktop.ini`, `~$*`, `.~lock.*`, `*.tmp`, Finder's `._*` files, and
bundles' extended attributes. Symlinks are not uploaded. A file over `STORAGE_MAX_FILE_BYTES`, or
any upload while the workspace is full or read-only (`402`), stays local with an error badge and
one notification, and retries when `/usage` says uploads are open.

## The shell (`apps/desktop`)

```
apps/desktop/
  src/                 the bundled local shell: server picker, offline screen (plain TS, no router)
  src-tauri/           Rust: windows, deep links, tray, updater, keychain, domain registration
    capabilities/      local.json (bundled shell), remote.json (the server origin, decision 2)
  macos/               Swift package: OmniFileProvider.appex, the omni-sync helper, build and signing script
  windows/             the Cloud Files provider (Rust crate, own binary), layer 7
  generated/           Swift and Rust types from @omni/contracts (decision 4)
```

Libraries, all official Tauri plugins unless noted: `deep-link`, `single-instance` (with its
`deep-link` feature, registered first), `updater`, `notification`, `autostart`, `window-state`,
`opener`, `store` (the chosen server), `log`. On macOS the domain, the sync sign-in and the
signals go through `omni-sync`, a Swift helper in `Contents/MacOS/` that Rust runs, and the app
keeps the sync token with `security-framework`; Windows keeps its
credentials with the `keyring` crate;
`tauri-plugin-decorum` or its maintained fork for Windows snap layouts on a custom title bar,
after a spike. Swift side: Foundation and FileProvider only.

- **First run.** A hosted build opens its configured origin directly. A build with no origin
  shows the server picker; the answer is stored and changeable from the app menu.
- **Window.** macOS: `titleBarStyle: Overlay`, hidden title, traffic lights positioned to sit on
  the navigation row's centre line. Windows: no native decorations, the web app draws minimize,
  maximize and close at the end of the same row.
- **Stays running.** Closing the window keeps the app in the menu bar / tray so the realtime
  signal keeps reaching the provider. The tray menu: Open Omni, Open Drive folder, sync status,
  Pause sync, Quit. Launch at login is on by default and a setting.
- **Notifications.** `apps/web/src/lib/desktop-notifications.ts` already wraps the browser API;
  on desktop it calls the notification plugin instead. Clicking one focuses the window on that
  thread. The Dock / taskbar badge shows the inbox count.
- **Links.** `omni://` opens threads and files in the app (`omni://open?path=/inbox/…`). Links to
  other origins open in the default browser. `mailto:` registers Omni as a mail handler and
  opens compose (macOS and Windows both ask the person first).
- **Updates.** The updater plugin, checked a minute after start and every 6 hours, downloaded in
  the background and installed while nobody is looking: at once if the window is closed, else
  when it next closes or the app quits; the app relaunches into the menu bar, window hidden.
  Because the UI comes from the server, a shell update is rare: native code, the extension,
  Tauri itself.

### Navigation changes in the web app

Small, and only when the page runs in the desktop shell (`lib/desktop.ts` detects it; the bridge
is loaded by dynamic import, so the browser bundle does not carry it). These are UI in
`apps/web`, asked for by the founder; they follow `DESIGN.md`, use existing `components/ui`
primitives, and add no text.

- A **title-bar group** at the top left, beside the traffic lights, on every screen: the
  workspace switcher as its icon only (the menu is unchanged), back and forward arrows (router
  history; disabled at either end), and the sidebar toggle. The whole row is a drag region
  except its controls.
- In the sidebar's top row the workspace switcher and the page headers' sidebar toggle are not
  drawn on desktop, since the title bar has them. Notifications stays where it is.
- `⌘[` / `⌘]` (`Alt+←` / `Alt+→` on Windows) go back and forward; `⌘,` opens Settings; `⌘N`
  compose; `⌘R` reloads. The app menu lists them.
- Exact placement of the sidebar toggle (title bar vs page header when the sidebar is closed) is
  settled in the layer that builds it, from a screenshot of both.

## Build, signing, release

- **macOS.** `beforeBundleCommand` (`tauri.macos.conf.json`) runs
  `apps/desktop/macos/scripts/build-macos.sh`, which builds the extension and `omni-sync` with
  SwiftPM and signs them (Developer ID, hardened runtime, their own entitlements, the extension's
  embedded provisioning profile). Tauri copies them to `Contents/PlugIns/` and `Contents/MacOS/`
  (`bundle.macOS.files`), signs the app last and notarizes. Entitlements:
  app sandbox and app group on the extension; the same app group and keychain access group on
  the app; associated domains on the app if passkeys are proven. Universal binary.
- **Windows.** NSIS installer, signed with Azure Trusted Signing through `signCommand`. WebView2
  bootstrapper for machines without it.
- **CI.** A `Desktop` workflow, on pull requests touching `apps/desktop/**`: Rust fmt, clippy
  and tests on Linux; unsigned compiles on macOS and Windows. `Checks` is unchanged for everyone
  else.
- **Releases.** Cut by release-please and run on GitHub's macOS runner
  (`desktop-release.yml`), or by hand on a Mac: `apps/desktop/scripts/release-macos.sh` builds the version in `tauri.conf.json` (universal,
  Developer ID, both profiles embedded, app and disk image notarized), signs the updater archive
  with the updater key, uploads it to the R2 bucket behind the Worker (`DESKTOP_BUCKET`), writes
  `/desktop/latest.json` last, checks the live feed and tags `desktop-v<version>`. The Worker
  serves `/desktop/latest.json`, `/desktop/download/:platform` and `/desktop/releases/*` from it,
  so a self-hoster publishes to their own. Every key is a file on that Mac, or a secret of the
  Doppler `prd_github` secret (synced to the GitHub environment `production`) written to a file for the job.
- **Config.** `OMNI_DESKTOP_ORIGIN` (optional default server), `OMNI_DESKTOP_BUNDLE_ID`,
  `OMNI_DESKTOP_APP_GROUP`, `APPLE_TEAM_ID`, updater public key and endpoint. Documented in
  `apps/desktop/.env.example` and `docs/self-hosting.md`.

### What only a person can do

| Who     | What                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Founder | Apple Developer Program team: Developer ID Application certificate; two App IDs (app, extension) with App Groups; Developer ID provisioning profiles for both; an App Store Connect API key for notarization. |
| Founder | Azure Trusted Signing account (or an OV certificate) for Windows.                                                                                 |
| Founder | First install on a real Mac: the File Provider cannot be built, signed or run from a cloud session. The macOS CI runner proves it compiles; a person proves it works in Finder. |
| Founder | The app icon and name as they appear in the Dock and Finder sidebar.                                                                              |

## Rollout

One stack on `main`, each layer one PR. Modules owned: Storage (db, contracts, Worker), the new
`apps/desktop`, and the shell files of `apps/web` named above.

| #   | Layer                                                                                              | Proven by                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | This spec.                                                                                         | Review.                                                                                                      |
| 2   | `apps/desktop` shell: Tauri, bundled local shell, server origin in the window, deep-link sign-in, tray, window chrome, updater wiring (no signing). `omni://` trusted. | Runs on Linux in the cloud session against `pnpm stack:serve`: sign in by magic link through the deep link, screenshot. Unsigned macOS and Windows builds in CI. |
| 3   | Web: `lib/desktop.ts`, the title-bar group, shortcuts, native notifications.                       | Screenshots in the shell and in the browser (unchanged there). WebKit smoke run in web e2e.                  |
| 4   | Storage sync, data: revisions, tombstones, content versions, the change feed in `@omni/db`.        | `packages/db` e2e: every write appears once and in order; two writers never skip; a purge leaves a tombstone. |
| 5   | Storage sync, Worker: `/sync/*`, replace-content uploads, version guards, `storage.changed`, the `storage:sync` scope and the Desktop client. | `apps/worker` e2e: a token for workspace A reads nothing of B and nothing of another member's My files; stale replace answers `409` and changes no bytes; expired cursor answers `410`. |
| 6   | Generated Swift and Rust types; macOS File Provider extension; domain registration, keychain, signalling; signing script. | Compiles on the macOS runner. On the founder's Mac, the checklist under "Verification".              |
| 7   | Windows Cloud Files provider, after a spike on `cloud-filter`.                                     | The same checklist on Windows.                                                                               |
| 8   | Release: signing in CI, updater feed, download routes, `docs/self-hosting.md`.                     | A signed build updates itself from the previous one on both systems.                                         |

Layers 2-3 and 4-5 do not depend on each other and can be built in parallel; 6 needs both.

## Verification

Server side is e2e against the local stack, each test named for the bug it catches (table above).
The providers cannot be tested here, so layer 6 and 7 ship with a written checklist run on real
machines and reported in the PR, pass or fail per line:

- A 200 MB file dragged into `My files` appears in the web app byte-identical (sha256); a file
  uploaded in the web app appears in Finder within 5 seconds with the app open, within 60 closed.
- Rename, move between folders, move between `My files` and `Shared`, trash and restore, each
  direction.
- Edit the same file on two computers offline, reconnect: one conflicted copy, no data lost.
- Pull the network mid-upload of a 1 GB file, reconnect: it resumes from the stored parts.
- "Remove download" frees the disk; opening the file downloads it again.
- A workspace at its cap: the upload shows an error badge and nothing is stored; freeing space
  lets it through without touching the file.
- Two workspaces synced: both appear under `Omni`; dragging a file from one to the other is
  refused as a move; turning one off removes its folder locally and leaves the server untouched.
- Sign out: the domain disappears, unsynced files are in `Not uploaded`, the token is revoked.
- Another member's My files never appears, including after that member is removed (their files
  arrive in the remover's My files as `Files from <name>`).

## Risks

- **File Provider needs real signing to run at all.** No profile, no testing. The plan front-loads
  the server and shell work that needs none, so the Apple setup is not on the critical path
  until layer 6.
- **WebKit differences.** PDF previews (pdf.js), Shiki, and motion are the likely spots. Layer 3's
  WebKit run finds them before a user does.
- **`cloud-filter` is pre-1.0** and documents two Windows bugs it works around. Layer 7 starts
  with a spike and has a named fallback.
- **Whether an installed, unpackaged Windows app may register a sync root** is not stated by
  Microsoft; the crate's own example does it. Checked in the spike on a clean machine. The
  fallback is a sparse MSIX identity ("packaging with external location").
- **Storage rows are the truth**. A sync bug can now trash files in bulk. Mitigations:
  deletes are always Trash; the provider refuses to send more than 500 deletes in one batch
  without the person confirming in the app; version guards on every write.
- **Remote content with native access.** The capability is small and pinned to one origin; an
  XSS in the web app could still raise a notification or disconnect sync, and nothing more.

## Settled with the founder (Nov 16, 2026)

- **No tabs in the title bar in this version.** They get their own short spec once the title-bar
  group exists.
- **Bundle identifier `app.omnidirectional.desktop`, shown as "Omni".** Permanent once installed.
  The extension is `app.omnidirectional.desktop.fileprovider`; the app group is
  `group.app.omnidirectional.desktop`. All three stay build config.
- **One "Omni" folder with a folder per workspace** (decision 3), not an entry per workspace.
- **Sync turns on for every workspace the first time the Mac app runs**, then is a
  switch per workspace in Settings → Drive.
- The macOS layers are built and run on the founder's Mac by an agent there.

## Notes for whoever builds it

Written for an agent starting from this document with none of the conversation behind it.

### Order and ownership

Build the layers in "Rollout" order, each as one PR stacked on the one before. Layer 2 (shell)
and layers 4-5 (server) can run as two parallel stacks: they share no file. Read `AGENTS.md`
first; Storage is a module and `scripts/check-modules.mjs` enforces its
edges. Schema changes go through `db:generate`, never a hand-written migration.

### The shell

- The bundled local page decides where to go: stored origin, else the build's default, else the
  picker. It then navigates the main window to that origin. `http(s)` navigations stay in the
  window (WebKit asks the same hook for subframes, and round trips need the window's cookies);
  new-window requests, `mailto:` and `tel:` go to the `opener` plugin; other schemes are dropped.
- Sign-in by deep link reuses what iOS does: read `apps/ios/src/lib/session.ts` and
  `apps/worker/e2e/ios-sign-in.e2e.test.ts` before writing it. The one difference is where the
  cookie goes: into the webview's cookie store for the server origin, then reload. Confirm the
  Tauri version in use can set a webview cookie from Rust before relying on it; if not, the
  fallback is a one-time code route on the Worker that the window itself opens, which sets the
  cookie as an ordinary response.
- `lib/desktop.ts` in `apps/web` is the only file that knows Tauri exists. It exposes a small
  typed object (`isDesktop`, `platform`, `back`, `forward`, `notify`, `setBadge`, `sync`) and
  every component reads that, never `window.__TAURI__`.
- Deep links do not fire in `tauri dev` on macOS: test sign-in from a bundled, installed build.

### The File Provider extension

- **Identifiers.** A Storage node is `<orgId>:<nodeId>`. The made-up levels are
  `ws:<orgId>`, `space:<orgId>:personal` and `space:<orgId>:shared`. The root is the system's
  `.rootContainer`. Parse, never guess: a node id alone does not say which workspace to call.
- **Item version.** `contentVersion` is the node's `content_version`, `metadataVersion` its
  `revision`, both as the decimal string's bytes. A folder's content version is constant.
- **Capabilities.** Made-up levels: read and enumerate; a space folder also allows adding
  children. A locked file (`lockedAt`): read only. Everything else: all of them, with delete
  meaning Trash.
- **Enumeration.** A folder's first listing is `GET /nodes?parent=` paged to the end. Changes
  come from the working-set enumerator only: its sync anchor is a small JSON map,
  `{ "<orgId>:<space>": <cursor> }`, one entry per synced drive, and `enumerateChanges` walks
  each drive's `/changes` from its cursor. A `410` on any drive answers
  `NSFileProviderError(.syncAnchorExpired)` and the system starts over. Trashed nodes and
  tombstones are reported as deletions; a restore arrives as an update and reappears.
- **Turning a workspace on or off** changes the root's children: signal the root and the working
  set. Turning one off removes its folder from the computer and nothing from the server.
- **Download** (`fetchContents`): stream `GET /files/:id/content` to a temporary file in the
  extension's container, report progress, honour cancellation, and resume with `Range` after a
  dropped connection. Return the item built from the response's version, not the one asked for.
- **Upload** (`createItem`, `modifyItem` with new contents): hash the file (sha256) while
  reading, open the upload (`POST /files/:id/versions` with `ifContentVersion` when modifying, sent
  again on complete), send 16 MiB parts
  four at a time, complete. Keep the upload id in a small file in the app group container,
  keyed by item identifier, so an extension that is killed
  resumes from `GET /uploads/:id` instead of starting over. The record keeps the sha256 and the file
  replaced, and an upload for other bytes is never resumed. A `409` follows "Conflicts".
- **Errors.** Map them, do not invent: `401` after one refresh attempt is `.notAuthenticated`
  (the app shows "Sign in again"); `402` is `.insufficientQuota`; `404` is `.noSuchItem`;
  offline is `.serverUnreachable`; a refused move between workspaces is `.cannotSynchronize`
  with a failure reason. Never return success for something the server refused.
- **Token refresh** happens in the extension and in the app, so guard it: refresh under a file
  lock in the app group container and re-read the keychain after taking the lock. Only a `400 invalid_grant`
  or a `401` from the token endpoint signs out; a `429`, a `5xx` or a dropped answer keeps the grant
  and the call is tried again.
- **No logic in two places.** The extension never decides access, names or conflicts beyond what
  this document says; when in doubt it asks the server and reports what it said.
- **Development.** Use the File Provider testing-mode entitlement to drive sync by hand, and
  `fileproviderctl` to inspect the domain. Remove the entitlement before a release build.

### Done means

A layer is done when its row under "Rollout" is proven the way that row says, the checks in
`AGENTS.md` ("Branching and shipping") pass, and its PR says what was run and what was seen.
For layers 6 and 7 that is the "Verification" checklist, line by line, on a real machine, with
failures reported as failures.
