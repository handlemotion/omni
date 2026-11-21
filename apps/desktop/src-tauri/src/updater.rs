//! Shell updates (docs/spec/desktop.md, "Updates"): checked a minute after start and every six
//! hours and downloaded in the background. A downloaded update installs on its own while nobody
//! is looking: at once if the window is closed (the app lives in the menu bar), else the next
//! time it is closed, or when the app quits. It then relaunches into the menu bar, window
//! hidden, as it was. The UI comes from the server, so these are rare: native code, the
//! extension, Tauri itself.
//!
//! Once one is downloaded the page hears `update-ready` (and can ask `update_ready`), so the
//! sidebar offers a restart; `update_install` restarts now, window shown. "Check for Updates…" in
//! the tray and app menu checks at once and says when there is nothing new.
//!
//! The manifest lives on the chosen Omni server, so a self-hosted build updates from its own
//! server; a build may name another feed. Each system has its own: macOS reads
//! `/desktop/latest.json` (the path installed Macs already ask for), Windows
//! `/desktop/windows/latest.json`, so the two release jobs publish apart and neither can offer
//! the other's build. Both the feed and the signing key are build config: a build without the
//! key never checks.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::server::Server;

/// The minisign public key releases are signed with (`tauri signer generate`).
pub const PUBKEY: Option<&str> = option_env!("OMNI_DESKTOP_UPDATER_PUBKEY");
/// A feed other than the server's own, e.g. `https://downloads.example.com/latest.json`.
const ENDPOINT: Option<&str> = option_env!("OMNI_DESKTOP_UPDATER_ENDPOINT");

const FIRST_CHECK: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Left in the app's data folder by an update restart: the relaunch keeps the window hidden.
const RELAUNCH_HIDDEN: &str = "relaunch-hidden";
/// Left by "Restart to update": the relaunch shows the window, even for a launch at login
/// (whose `--hidden` argument the restart keeps).
const RELAUNCH_SHOWN: &str = "relaunch-shown";

/// What a check found.
enum Checked {
    /// An update is downloaded, now or by an earlier check.
    Ready,
    UpToDate,
    /// Another check is running.
    Busy,
}

/// The event the page hears when an update is downloaded, with its version.
const READY_EVENT: &str = "update-ready";

/// A downloaded update waiting for the app to quit, and whether a check is running.
#[derive(Default)]
pub struct Pending {
    update: Mutex<Option<(Update, Vec<u8>)>>,
    checking: AtomicBool,
}

impl Pending {
    fn version(&self) -> Option<String> {
        self.update
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|(update, _)| update.version.clone())
    }
}

/// The server's manifest for this system (`apps/worker/src/routes/desktop.ts`).
const SERVER_FEED: &str = if cfg!(target_os = "windows") {
    "desktop/windows/latest.json"
} else {
    "desktop/latest.json"
};

/// The manifest URL: the build's feed if it names one, else the server's `path`.
pub fn endpoint(feed: Option<&str>, server: &Url, path: &str) -> Option<Url> {
    match feed.filter(|feed| !feed.is_empty()) {
        Some(feed) => Url::parse(feed).ok(),
        None => server.join(path).ok(),
    }
}

/// Starts the check loop. Without a signing key in the build, updates are off.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if PUBKEY.is_none_or(str::is_empty) {
        eprintln!("updates are off: this build has no OMNI_DESKTOP_UPDATER_PUBKEY");
        return;
    }
    app.manage(Pending::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            match check(&app).await {
                Ok(Checked::Ready) => install_if_idle(&app),
                Ok(Checked::UpToDate | Checked::Busy) => {}
                Err(error) => eprintln!("update check failed: {error}"),
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Checks for an update and downloads it.
async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Checked, String> {
    let pending = app.state::<Pending>();
    if pending.version().is_some() {
        return Ok(Checked::Ready);
    }
    if pending.checking.swap(true, Ordering::AcqRel) {
        return Ok(Checked::Busy);
    }
    let checked = download(app).await;
    pending.checking.store(false, Ordering::Release);
    checked
}

async fn download<R: Runtime>(app: &AppHandle<R>) -> Result<Checked, String> {
    let Some(server) = app.state::<Server>().current() else {
        return Ok(Checked::UpToDate);
    };
    let url = endpoint(ENDPOINT, &server, SERVER_FEED).ok_or("no update feed")?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Checked::UpToDate);
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    eprintln!(
        "update {} downloaded; it installs when Omni quits",
        update.version
    );
    let version = update.version.clone();
    *app.state::<Pending>()
        .update
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some((update, bytes));
    let _ = app.emit(READY_EVENT, version);
    Ok(Checked::Ready)
}

/// "Check for Updates…": checks now. A downloaded update brings the window forward, where the
/// sidebar offers the restart; otherwise a notification says there is nothing new, or that the
/// check failed.
pub fn check_now<R: Runtime>(app: &AppHandle<R>) {
    if app.try_state::<Pending>().is_none() {
        notify(app, "Updates are off in this build of Omni");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&app).await {
            Ok(Checked::Ready) => crate::window::show(&app),
            Ok(Checked::UpToDate) => notify(&app, "Omni is up to date"),
            Ok(Checked::Busy) => notify(&app, "Omni is already checking for updates"),
            Err(error) => {
                eprintln!("update check failed: {error}");
                notify(&app, "Omni couldn’t check for updates");
            }
        }
    });
}

fn notify<R: Runtime>(app: &AppHandle<R>, title: &str) {
    if let Err(error) = app.notification().builder().title(title).show() {
        eprintln!("could not show a notification: {error}");
    }
}

/// The version of the downloaded update waiting to install, if any.
#[tauri::command]
pub fn update_ready<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    app.try_state::<Pending>()?.version()
}

/// Restarts now into the downloaded update (the exit installs it), window shown.
#[tauri::command]
pub fn update_install<R: Runtime>(app: AppHandle<R>) {
    if update_ready(app.clone()).is_some() {
        mark_relaunch(&app, RELAUNCH_SHOWN);
        app.request_restart();
    }
}

/// Leaves `mark` in the app's data folder for the relaunch to read (`relaunch`).
fn mark_relaunch<R: Runtime>(app: &AppHandle<R>, mark: &str) {
    if let Ok(dir) = app.path().app_data_dir()
        && let Err(error) =
            std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(dir.join(mark), b""))
    {
        eprintln!("could not mark the update relaunch: {error}");
    }
}

/// Installs a downloaded update now if the window is closed: the restart quits the app (the
/// exit installs it, `install_pending`) and relaunches it hidden. With the window open, the
/// update waits for it to close (`window.rs` calls this once it has hidden the window).
pub fn install_if_idle<R: Runtime>(app: &AppHandle<R>) {
    let pending = app
        .try_state::<Pending>()
        .is_some_and(|pending| pending.version().is_some());
    let open = app
        .get_webview_window("main")
        .is_some_and(|window| window.is_visible().unwrap_or(true));
    if !pending || open {
        return;
    }
    mark_relaunch(app, RELAUNCH_HIDDEN);
    app.request_restart();
}

/// How an update relaunch shows the window: `Some(false)` keeps it hidden (the update installed
/// while nobody was looking), `Some(true)` shows it ("Restart to update"), `None` is an ordinary
/// launch. Answers once: the marks are removed as they are read.
pub fn relaunch<R: Runtime, M: Manager<R>>(app: &M) -> Option<bool> {
    let dir = app.path().app_data_dir().ok()?;
    let take = |mark: &str| std::fs::remove_file(dir.join(mark)).is_ok();
    let hidden = take(RELAUNCH_HIDDEN);
    if take(RELAUNCH_SHOWN) {
        return Some(true);
    }
    hidden.then_some(false)
}

/// Installs a downloaded update, if any. Called once, as the app exits.
pub fn install_pending<R: Runtime>(app: &AppHandle<R>) {
    let Some(pending) = app.try_state::<Pending>() else {
        return;
    };
    let taken = pending
        .update
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some((update, bytes)) = taken
        && let Err(error) = update.install(bytes)
    {
        eprintln!("could not install update {}: {error}", update.version);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bug: a build without its own feed must ask the server it shows, not a hard-coded host, or
    // a self-hosted install would update from someone else's releases.
    #[test]
    fn the_feed_is_the_servers_unless_the_build_names_one() {
        let server = Url::parse("https://omni.example.com/").unwrap();
        let path = "desktop/latest.json";
        assert_eq!(
            endpoint(None, &server, path).map(String::from),
            Some("https://omni.example.com/desktop/latest.json".into())
        );
        assert_eq!(
            endpoint(Some(""), &server, path).map(String::from),
            Some("https://omni.example.com/desktop/latest.json".into())
        );
        assert_eq!(
            endpoint(
                Some("https://downloads.example.com/latest.json"),
                &server,
                path
            )
            .map(String::from),
            Some("https://downloads.example.com/latest.json".into())
        );
    }

    // Bug: macOS and Windows reading one manifest, each release job would overwrite the other's
    // and a Mac would be offered the Windows installer (or a Windows app the version of a Mac
    // release it has no file for, downloading the same old build forever). Installed Macs ask
    // for `desktop/latest.json`, so that path must stay theirs.
    #[test]
    fn each_system_reads_its_own_manifest() {
        if cfg!(target_os = "windows") {
            assert_eq!(SERVER_FEED, "desktop/windows/latest.json");
        } else {
            assert_eq!(SERVER_FEED, "desktop/latest.json");
        }
    }
}
