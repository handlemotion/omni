# @omni/desktop rules

Extends the root `AGENTS.md`. The design is `docs/spec/desktop.md` and ADR 0043: read both first.

- Tauri 2. The main window loads the Omni server's origin; the only bundled page is `src/` (server
  picker, offline screen). It never calls `/api`, and no product logic lives in Rust or Swift.
- Folders and their owners, so layers can run in parallel without touching each other's files:

  | Folder                           | Owner (spec "Rollout")                               |
  | -------------------------------- | ---------------------------------------------------- |
  | `src/`, `src-tauri/` but `sync/` | Shell (layer 2)                                      |
  | `src-tauri/src/sync/`, `macos/`  | macOS File Provider (layer 6)                        |
  | `windows/`                       | Windows Cloud Files (layer 7)                        |
  | `generated/`                     | Nobody: `pnpm --filter @omni/contracts native-types` |

  `src-tauri/src/lib.rs` (plugin and command registration) and `Cargo.toml` are shared: keep each
  change to them one line where you can.

- Wire shapes come from `generated/` (Swift and Rust, from `@omni/contracts`). Never write a
  request or response struct by hand; add the schema to `STORAGE_SYNC_NATIVE_TYPES` instead.
- The web app talks to the shell only through the commands in `src-tauri/src/sync/` and the
  official plugins the remote capability grants. Adding a command means adding it to that
  capability too.
- Rust: `cargo fmt`, `cargo clippy --all-targets` with every Clippy lint denied, no `unsafe`.
  Tests only for pure logic, named for the bug they catch (ADR 0043, "Consequences").
- Config is build-time env (`.env.example`); nothing Handlemotion-specific in code.
- Run it: `pnpm --filter @omni/desktop dev` (Linux needs WebKitGTK 4.1, see Tauri's
  prerequisites). `OMNI_DESKTOP_ORIGIN=http://127.0.0.1:8787` after `pnpm stack:serve` opens the
  local stack. Deep links do not fire in `tauri dev` on macOS: test them from an installed build.
