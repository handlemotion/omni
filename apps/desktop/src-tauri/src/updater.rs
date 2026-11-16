//! Shell updates (docs/spec/desktop.md, "Updates"): checked a minute after start and every six
//! hours, downloaded in the background, installed when the app quits. The UI comes from the
//! server, so these are rare: native code, the extension, Tauri itself.
//!
//! The manifest lives on the chosen Omni server (`/desktop/latest.json`, the release layer's
//! route), so a self-hosted build updates from its own server; a build may name another feed.
//! Both the feed and the signing key are build config: a build without the key never checks.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::server::Server;

/// The minisign public key releases are signed with (`tauri signer generate`).
pub const PUBKEY: Option<&str> = option_env!("OMNI_DESKTOP_UPDATER_PUBKEY");
/// A feed other than the server's own, e.g. `https://downloads.example.com/latest.json`.
const ENDPOINT: Option<&str> = option_env!("OMNI_DESKTOP_UPDATER_ENDPOINT");

const FIRST_CHECK: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// A downloaded update waiting for the app to quit.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// The manifest URL: the build's feed if it names one, else the server's.
pub fn endpoint(feed: Option<&str>, server: &Url) -> Option<Url> {
    match feed.filter(|feed| !feed.is_empty()) {
        Some(feed) => Url::parse(feed).ok(),
        None => server.join("desktop/latest.json").ok(),
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
            if let Err(error) = check(&app).await {
                eprintln!("update check failed: {error}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app
        .state::<Pending>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .is_some()
    {
        return Ok(());
    }
    let Some(server) = app.state::<Server>().current() else {
        return Ok(());
    };
    let url = endpoint(ENDPOINT, &server).ok_or("no update feed")?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    eprintln!(
        "update {} downloaded; it installs when Omni quits",
        update.version
    );
    *app.state::<Pending>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some((update, bytes));
    Ok(())
}

/// Installs a downloaded update, if any. Called once, as the app exits.
pub fn install_pending<R: Runtime>(app: &AppHandle<R>) {
    let Some(pending) = app.try_state::<Pending>() else {
        return;
    };
    let taken = pending
        .0
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
        assert_eq!(
            endpoint(None, &server).map(String::from),
            Some("https://omni.example.com/desktop/latest.json".into())
        );
        assert_eq!(
            endpoint(Some(""), &server).map(String::from),
            Some("https://omni.example.com/desktop/latest.json".into())
        );
        assert_eq!(
            endpoint(Some("https://downloads.example.com/latest.json"), &server).map(String::from),
            Some("https://downloads.example.com/latest.json".into())
        );
    }
}
