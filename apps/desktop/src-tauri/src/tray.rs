//! The menu bar / tray icon and the app menu (docs/spec/desktop.md, "Stays running").
//!
//! Tray: Open Omni, Record Now (Stop Recording while one runs), Change Server…, Check for
//! Updates…, Quit. Sync's entries (Open Drive folder, its status, Pause
//! sync) join here once the File Provider layer has commands behind them. On macOS the app menu
//! also gets "Change Server…" and "Check for Updates…", after "About Omni".

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, Runtime};

use crate::{recording, updater, window};

const OPEN: &str = "open";
const CHANGE_SERVER: &str = "change-server";
const CHECK_UPDATES: &str = "check-updates";
const CHECK_UPDATES_LABEL: &str = "Check for Updates…";
const QUIT: &str = "quit";
const RECORD: &str = "record";
const RECORD_LABEL: &str = "Record Now";
const STOP_LABEL: &str = "Stop Recording";

/// The tray's record item, relabelled while a recording runs.
struct RecordItem<R: Runtime>(MenuItem<R>);

pub fn create<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let record = MenuItem::with_id(app, RECORD, RECORD_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN, "Open Omni", true, None::<&str>)?,
            &record,
            &MenuItem::with_id(app, CHANGE_SERVER, "Change Server…", true, None::<&str>)?,
            &MenuItem::with_id(app, CHECK_UPDATES, CHECK_UPDATES_LABEL, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Quit Omni", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Omni")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                window::show(tray.app_handle());
            }
        });
    if cfg!(target_os = "macos") {
        // A template image (the mark in black on clear): macOS draws it in the menu bar's own
        // colour, light or dark, as it does its own icons.
        tray = tray
            .icon(tauri::include_image!("icons/tray.png"))
            .icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(RecordItem(record));
    // One handler for the tray's menu and the app menu: both carry the same ids.
    app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));

    if cfg!(target_os = "macos") {
        app_menu(app)?;
    }
    Ok(())
}

/// The platform's default menu with "Change Server…" and "Check for Updates…" in the app's own
/// submenu.
fn app_menu<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    if let Some(app_submenu) = menu
        .items()?
        .first()
        .and_then(|item| item.as_submenu().cloned())
    {
        let item = MenuItem::with_id(app, CHANGE_SERVER, "Change Server…", true, None::<&str>)?;
        let updates =
            MenuItem::with_id(app, CHECK_UPDATES, CHECK_UPDATES_LABEL, true, None::<&str>)?;
        app_submenu.insert_items(&[&PredefinedMenuItem::separator(app)?, &item, &updates], 1)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        OPEN => window::show(app),
        RECORD if app.state::<recording::Recording>().is_busy() => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = recording::stop(&app).await {
                    eprintln!("could not stop the recording: {}", error.message);
                }
            });
        }
        RECORD => recording::request(app),
        CHANGE_SERVER => window::change_server(app),
        CHECK_UPDATES => updater::check_now(app),
        QUIT => app.exit(0),
        _ => {}
    }
}

/// "Record Now" while nothing records, "Stop Recording" while something does.
pub fn set_recording<R: Runtime>(app: &AppHandle<R>, recording: bool) {
    if let Some(item) = app.try_state::<RecordItem<R>>() {
        let _ = item
            .0
            .set_text(if recording { STOP_LABEL } else { RECORD_LABEL });
    }
}
