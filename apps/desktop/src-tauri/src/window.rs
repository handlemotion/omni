//! The main window. Built here rather than in `tauri.conf.json` so it carries the navigation
//! guard (`navigation.rs`): web pages and the bundled shell load in it, `mailto:` and `tel:` open
//! their apps, and anything asking for a new window opens in the default browser. Downloads are
//! saved to the Downloads folder (WebKit cancels them when no handler is set).
//!
//! Closing the window hides it: the app stays in the menu bar / tray so sync keeps hearing from
//! the server (docs/spec/desktop.md, "Stays running").

use std::sync::Arc;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{App, AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::navigation::{Destination, destination, local_origins};

/// Where the bundled shell was served from, so the app can return to its server picker.
pub struct LocalShell(pub Url);

/// The flag autostart launches with: start in the menu bar / tray, window hidden.
pub const HIDDEN_ARG: &str = "--hidden";

pub fn create<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let dev_url = if cfg!(dev) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let local = Arc::new(local_origins(dev_url.as_ref()));

    let on_navigation = {
        let (app, local) = (app.handle().clone(), local.clone());
        move |url: &Url| route(&app, url, &local, false)
    };
    let on_new_window = {
        let app = app.handle().clone();
        move |url: Url, _| {
            route(&app, &url, &local, true);
            NewWindowResponse::Deny
        }
    };

    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
    let window = chrome(builder)
        .title("Omni")
        .inner_size(1280.0, 800.0)
        .min_inner_size(720.0, 480.0)
        .visible(!std::env::args().any(|arg| arg == HIDDEN_ARG))
        .on_navigation(on_navigation)
        .on_new_window(on_new_window)
        // The destination arrives filled in: the Downloads folder, the suggested name, made unique.
        .on_download(|_, event| {
            if let DownloadEvent::Finished {
                url,
                success: false,
                ..
            } = event
            {
                eprintln!("download failed: {url}");
            }
            true
        })
        .build()?;
    app.manage(LocalShell(window.url()?));
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide.hide();
        }
    });
    Ok(())
}

/// The window chrome (docs/spec/desktop.md, "Window"). macOS: the title bar overlays the page,
/// no title, traffic lights on the web title bar's centre line. Windows and Linux keep the native
/// frame until the web app and the bundled page draw minimize, maximize and close themselves.
fn chrome<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(16.0, 18.0));
    builder
}

/// Brings the main window back: from the tray, the Dock, a deep link or a second launch.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Back to the bundled page's server picker ("Change Server…" in the app menu and tray).
pub fn change_server<R: Runtime>(app: &AppHandle<R>) {
    show(app);
    let mut picker = app.state::<LocalShell>().0.clone();
    picker.set_query(Some("pick"));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(picker);
    }
}

/// True when the window may load `url`. A new-window request never loads in this window: the app
/// has one, so a web page asking for another opens in the default browser.
fn route<R: Runtime>(app: &AppHandle<R>, url: &Url, local: &[Url], new_window: bool) -> bool {
    match destination(url, local) {
        Destination::Window if !new_window => true,
        Destination::Window | Destination::Browser
            if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") =>
        {
            if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
                eprintln!("could not open {url}: {error}");
            }
            false
        }
        _ => false,
    }
}
