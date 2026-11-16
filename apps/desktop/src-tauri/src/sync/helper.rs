//! Runs `omni-sync` (apps/desktop/macos/Sources/OmniSyncHelper) and reads its one line of JSON.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use omni_sync_types::{
    DesktopSyncDone, DesktopSyncSignIn, DesktopSyncState, DesktopSyncStatus, DesktopWorkspaceSync,
};
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager, Runtime, Url};

/// A sign-in the window is in the middle of: the workspace that asked, and the page to return to.
#[derive(Default)]
struct Pending(Mutex<Option<(String, Url)>>);

const POLL: Duration = Duration::from_secs(60);

fn path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(exe.with_file_name("omni-sync"))
}

/// One run of the helper. A failure is its stderr line.
fn run<T: DeserializeOwned>(args: &[&str]) -> Result<T, String> {
    let output = Command::new(path()?)
        .args(args)
        .output()
        .map_err(|error| format!("omni-sync did not start: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("omni-sync answered: {error}"))
}

/// Runs the helper off the async runtime's threads.
async fn call<T: DeserializeOwned + Send + 'static>(args: Vec<String>) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(&args)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn status() -> Result<DesktopSyncStatus, String> {
    call(vec!["status".into()]).await
}

pub async fn connect<R: Runtime>(
    app: &AppHandle<R>,
    org_id: String,
) -> Result<DesktopWorkspaceSync, String> {
    let answer: DesktopWorkspaceSync = call(vec!["connect".into(), org_id.clone()]).await?;
    if answer.state != DesktopSyncState::NeedsAttention {
        return Ok(answer);
    }
    // No sync grant yet: the server's authorize page, in the window already signed in there.
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let here = window.url().map_err(|error| error.to_string())?;
    let origin = here.origin().ascii_serialization();
    let opened: DesktopSyncSignIn = call(vec!["sign-in".into(), origin]).await?;
    let authorize = Url::parse(&opened.url).map_err(|error| error.to_string())?;
    if let Ok(mut pending) = app.state::<Pending>().0.lock() {
        *pending = Some((org_id, here));
    }
    window
        .navigate(authorize)
        .map_err(|error| error.to_string())?;
    Ok(answer)
}

pub async fn disconnect(org_id: String) -> Result<DesktopWorkspaceSync, String> {
    call(vec!["disconnect".into(), org_id]).await
}

#[expect(
    dead_code,
    reason = "reached through `oauth_callback`, which the shell will call"
)]
pub async fn finish_sign_in<R: Runtime>(app: &AppHandle<R>, url: String) -> Result<(), String> {
    let _: DesktopSyncDone = call(vec!["finish-sign-in".into(), url]).await?;
    let pending = app
        .state::<Pending>()
        .0
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    if let Some((org_id, back)) = pending {
        let _: DesktopWorkspaceSync = call(vec!["connect".into(), org_id]).await?;
        if let Some(window) = app.get_webview_window("main") {
            window.navigate(back).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Pending::default());
    std::thread::spawn(|| {
        loop {
            std::thread::sleep(POLL);
            let synced = run::<DesktopSyncStatus>(&["status"])
                .is_ok_and(|status| !status.workspaces.is_empty());
            if synced {
                // A failure here is the extension's to report, as a badge in Finder.
                let _: Result<DesktopSyncDone, String> = run(&["signal"]);
            }
        }
    });
}
