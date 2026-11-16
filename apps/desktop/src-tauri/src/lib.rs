//! The desktop shell (ADR 0043): windows, deep links, tray, updater, keychain, and telling the
//! sync provider that something changed. No product logic lives here.
//!
//! Ownership: `sync/` belongs to the File Provider layer; the rest of the shell to the shell
//! layer. Plugins and commands are registered here, the one shared line between them.

mod sync;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            sync::sync_status,
            sync::sync_connect,
            sync::sync_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omni");
}
