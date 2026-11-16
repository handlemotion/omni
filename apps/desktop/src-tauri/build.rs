// Every command of ours is listed, so Tauri generates an `allow-<command>` permission for each
// and denies it to any window whose capability does not grant it (`capabilities/`, and the
// runtime `remote` capability in `src/server.rs`).
const COMMANDS: &[&str] = &[
    "server_origin",
    "open_server",
    "sign_in_callback",
    "sync_status",
    "sync_connect",
    "sync_disconnect",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
