//! The desktop shell (ADR 0043): windows, deep links, tray, updater, keychain, and telling the
//! sync provider that something changed. No product logic lives here.
//!
//! Ownership: `sync/` belongs to the File Provider layer; the rest of the shell to the shell
//! layer. Plugins and commands are registered here, the one shared line between them.

mod deep_link;
mod navigation;
mod server;
mod startup;
mod sync;
mod tray;
mod updater;
mod window;

pub fn run() {
    tauri::Builder::default()
        // First: a second launch (how Linux and Windows deliver an `omni://` link to a running
        // app) hands its URL to the deep-link plugin below and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            window::show(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // The key is build config; without it `updater::start` never checks.
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(updater::PUBKEY.unwrap_or_default())
                .build(),
        )
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args([window::HIDDEN_ARG])
                .build(),
        )
        // Size and place, not visibility: a login launch stays hidden.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .manage(server::Server::default())
        .manage(deep_link::SignIns::default())
        .invoke_handler(tauri::generate_handler![
            server::server_origin,
            server::open_server,
            deep_link::sign_in_callback,
            sync::sync_status,
            sync::sync_connect,
            sync::sync_disconnect,
        ])
        .setup(|app| {
            window::create(app)?;
            tray::create(app)?;
            deep_link::listen(app);
            startup::default_on(app);
            updater::start(app.handle());
            sync::start(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Omni")
        .run(|app, event| {
            // macOS: clicking the Dock icon with the window closed brings it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                window::show(app);
            }
            if let tauri::RunEvent::Exit = event {
                updater::install_pending(app);
            }
        });
}
