//! Runs `omni-sync` (apps/desktop/macos/Sources/OmniSyncHelper) and reads its one line of JSON.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use omni_sync_types::{
    DesktopSyncDone, DesktopSyncSignIn, DesktopSyncState, DesktopSyncStatus, DesktopSyncTokens,
    DesktopWorkspaceSync,
};

use super::keychain;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Manager, Runtime, Url};

/// A sign-in the window is in the middle of: the workspace that asked, and the page to return to.
#[derive(Default)]
struct Pending(Mutex<Option<(String, Url)>>);

/// Longest any one run may take. A helper stuck on the system (a File Provider call that never
/// answers) is killed, so the command that ran it answers instead of hanging the switch.
const TIMEOUT: Duration = Duration::from_secs(60);

fn path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(exe.with_file_name("omni-sync"))
}

/// One run of the helper, killed after `TIMEOUT`. A failure is its stderr line.
pub fn run<T: DeserializeOwned>(args: &[&str]) -> Result<T, String> {
    let mut child = Command::new(path()?)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("omni-sync did not start: {error}"))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "omni-sync {} did not answer in {}s",
                args.first().unwrap_or(&""),
                TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_owned());
    }
    serde_json::from_slice(&stdout).map_err(|error| format!("omni-sync answered: {error}"))
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

/// `sync.json`'s view, with any workspace that is on marked `needs_attention` while the app
/// holds no grant (never signed in, or the server refused it).
pub async fn status<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopSyncStatus, String> {
    let mut status: DesktopSyncStatus = call(vec!["status".into()]).await?;
    if !keychain::holds(app) {
        for workspace in &mut status.workspaces {
            if workspace.state != DesktopSyncState::Off {
                workspace.state = DesktopSyncState::NeedsAttention;
            }
        }
    }
    Ok(status)
}

pub async fn connect<R: Runtime>(
    app: &AppHandle<R>,
    org_id: String,
) -> Result<DesktopWorkspaceSync, String> {
    if keychain::holds(app) {
        let answer: DesktopWorkspaceSync = call(vec!["connect".into(), org_id.clone()]).await?;
        // A grant without `sync.json` (kept from an earlier install or a sign-out) cannot turn
        // sync on: the helper answers `needs_attention` and the switch flips back with no error,
        // every time. Sign in again instead, which writes `sync.json`.
        if answer.state != DesktopSyncState::NeedsAttention {
            return Ok(answer);
        }
    }
    // No usable sync grant: the server's authorize page, in the window already signed in there.
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let here = window.url().map_err(|error| error.to_string())?;
    let origin = here.origin().ascii_serialization();
    let opened: DesktopSyncSignIn = call(vec!["sign-in".into(), origin]).await?;
    let authorize = Url::parse(&opened.url).map_err(|error| error.to_string())?;
    if let Ok(mut pending) = app.state::<Pending>().0.lock() {
        *pending = Some((org_id.clone(), here));
    }
    window
        .navigate(authorize)
        .map_err(|error| error.to_string())?;
    Ok(DesktopWorkspaceSync {
        org_id,
        state: DesktopSyncState::NeedsAttention,
    })
}

pub async fn disconnect(org_id: String) -> Result<DesktopWorkspaceSync, String> {
    call(vec!["disconnect".into(), org_id]).await
}

pub async fn finish_sign_in<R: Runtime>(app: &AppHandle<R>, url: String) -> Result<(), String> {
    let tokens: DesktopSyncTokens = call(vec!["finish-sign-in".into(), url]).await?;
    keychain::store(app, &tokens)?;
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

/// The workspaces sync is on for now, when the app holds a grant.
pub fn synced<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    if !keychain::holds(app) {
        return Vec::new();
    }
    run::<DesktopSyncStatus>(&["status"]).map_or_else(
        |_| Vec::new(),
        |status| {
            status
                .workspaces
                .into_iter()
                .filter(|workspace| workspace.state == DesktopSyncState::Synced)
                .map(|workspace| workspace.org_id)
                .collect()
        },
    )
}

/// Asks the extension to read the change feeds. A failure here is the extension's to report, as
/// a badge in Finder.
pub fn signal() {
    let _: Result<DesktopSyncDone, String> = run(&["signal"]);
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Pending::default());
    super::watch::start(app);
}
