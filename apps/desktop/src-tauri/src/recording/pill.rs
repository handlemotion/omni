//! The pill (docs/spec/meetings.md, "How people use it"): a small window on top of every other,
//! on every desktop, for as long as a recording runs. A red dot, the time, the mic level, pause
//! and stop. It is the bundled `pill.html`, which hears `recording-changed` and calls the
//! recorder's pause, resume and stop. It has no close button: it goes when the recording does.

use tauri::{AppHandle, LogicalPosition, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "pill";
const WIDTH: f64 = 196.0;
const HEIGHT: f64 = 40.0;
const TOP: f64 = 12.0;

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pill.html".into()))
                .title("Omni recording")
                .inner_size(WIDTH, HEIGHT)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build();
            match built {
                Ok(window) => window,
                Err(error) => {
                    eprintln!("could not open the recording pill: {error}");
                    return;
                }
            }
        }
    };
    // Top centre of the screen the person is on.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let origin = monitor.position().to_logical::<f64>(scale);
        let _ = window.set_position(LogicalPosition::new(
            origin.x + (size.width - WIDTH) / 2.0,
            origin.y + TOP,
        ));
    }
    let _ = window.show();
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}
