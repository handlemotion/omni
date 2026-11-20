//! Which Omni server the window shows (docs/spec/desktop.md, "The shell"). The bundled page
//! decides (stored choice, else the build's default, else the picker) and calls `open_server`;
//! this module keeps the choice, grants that origin the remote capability and sends the window
//! there.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_store::StoreExt;
use url::Url;

use crate::deep_link::{is_app_path, on_server};

const STORE: &str = "shell.json";
const SERVER_KEY: &str = "server";

/// What the server origin may call: window dragging and controls, the
/// badge, notifications (and showing the window when one is clicked), the launch-at-login switch, opening links outside, events, the magic-link callback
/// (`deep_link.rs`) and the sync commands. No filesystem,
/// no shell, no HTTP. A new command of ours is added here as well as in `build.rs`.
const REMOTE_PERMISSIONS: &[&str] = &[
    "core:event:default",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-is-maximized",
    "core:window:allow-is-fullscreen",
    "core:window:allow-close",
    "core:window:allow-set-badge-count",
    "core:window:allow-show",
    "core:window:allow-unminimize",
    "core:window:allow-set-focus",
    "notification:default",
    "autostart:allow-enable",
    "autostart:allow-disable",
    "autostart:allow-is-enabled",
    "opener:allow-open-url",
    "opener:allow-default-urls",
    "allow-sign-in-callback",
    "allow-sync-status",
    "allow-sync-connect",
    "allow-sync-disconnect",
];

/// The chosen server, shared with the navigation guard, and the origins already granted the
/// remote capability this run (a capability cannot be taken back, only not added twice).
#[derive(Default)]
pub struct Server {
    pub origin: Arc<Mutex<Option<Url>>>,
    granted: Mutex<HashSet<String>>,
}

impl Server {
    /// The chosen server, if the bundled page has opened one.
    pub fn current(&self) -> Option<Url> {
        self.origin
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// The origin of what the person typed or the build set: `https://` when no scheme is given,
/// path, query and fragment dropped. Only `http` and `https` with a host and no credentials.
pub fn parse_origin(input: &str) -> Result<Url, String> {
    let input = input.trim();
    let with_scheme = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| format!("not a server address: {input}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(format!("not a server address: {input}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("a server address has no user name or password".into());
    }
    let mut origin = url;
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    Ok(origin)
}

/// The stored choice, if any. The build's default lives in the bundled page.
#[tauri::command]
pub fn server_origin<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let store = app.store(STORE).ok()?;
    let value = store.get(SERVER_KEY)?;
    parse_origin(value.as_str()?).ok().map(String::from)
}

/// Keep `origin` as the server, let it call the remote capability, and load it in the window:
/// at `path` when one is given and stays on the server (a page reopened after it died,
/// `recovery.rs`), else at its root.
#[tauri::command]
pub fn open_server<R: Runtime>(
    app: AppHandle<R>,
    server: State<'_, Server>,
    origin: String,
    path: Option<String>,
) -> Result<(), String> {
    let origin = parse_origin(&origin)?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    store.set(SERVER_KEY, origin.as_str());
    store.save().map_err(|e| e.to_string())?;

    let mut granted = server
        .granted
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if !granted.contains(origin.as_str()) {
        let capability = REMOTE_PERMISSIONS.iter().fold(
            CapabilityBuilder::new(format!("remote-{}", granted.len()))
                .remote(origin.to_string())
                .window("main"),
            |capability, permission| capability.permission(*permission),
        );
        app.add_capability(capability).map_err(|e| e.to_string())?;
        granted.insert(origin.to_string());
    }
    drop(granted);

    let page = path
        .filter(|path| is_app_path(path))
        .and_then(|path| on_server(&origin, &path))
        .unwrap_or_else(|| origin.clone());
    *server.origin.lock().unwrap_or_else(PoisonError::into_inner) = Some(origin);
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is gone")?;
    window.navigate(page).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bug: a path kept from the picker's input would narrow the remote capability to that path,
    // and every other page of the app would lose its commands.
    #[test]
    fn an_address_becomes_its_origin() {
        let origin = |s: &str| parse_origin(s).map(String::from);
        assert_eq!(
            origin("omni.example.com"),
            Ok("https://omni.example.com/".into())
        );
        assert_eq!(
            origin(" http://127.0.0.1:8787/inbox?x=1#y "),
            Ok("http://127.0.0.1:8787/".into())
        );
        assert_eq!(
            origin("https://omni.example.com:443/"),
            Ok("https://omni.example.com/".into())
        );
    }

    // Bug: a `file:` or credential-bearing address would be stored and granted the capability.
    #[test]
    fn only_plain_web_origins_are_servers() {
        for bad in [
            "",
            "https://",
            "file:///etc",
            "ftp://omni.example.com",
            "https://a:b@omni.example.com",
        ] {
            assert!(parse_origin(bad).is_err(), "{bad}");
        }
    }
}
