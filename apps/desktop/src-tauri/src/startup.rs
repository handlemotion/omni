//! Launch at login (docs/spec/desktop.md, "Stays running"): on by default, so it is switched on
//! once, on the first run, and the person's later choice (Settings, through the autostart
//! plugin's commands) is never overridden. A login launch starts hidden in the menu bar / tray.

use tauri::{App, Runtime};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_store::StoreExt;

const STORE: &str = "shell.json";
const DEFAULTED_KEY: &str = "autostart_defaulted";

pub fn default_on<R: Runtime>(app: &App<R>) {
    let Ok(store) = app.store(STORE) else { return };
    if store.get(DEFAULTED_KEY).is_some() {
        return;
    }
    if let Err(error) = app.autolaunch().enable() {
        eprintln!("could not turn on launch at login: {error}");
        return;
    }
    store.set(DEFAULTED_KEY, true);
    let _ = store.save();
}
