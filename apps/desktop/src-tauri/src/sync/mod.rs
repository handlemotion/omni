//! Drive sync, as the web app sees it: the three commands the server
//! origin may call. Settings → Drive reads `sync_status` and switches a workspace with
//! `sync_connect` / `sync_disconnect`. Their shapes are `desktopSyncStatusSchema` and
//! `desktopWorkspaceSyncSchema` in `@omni/contracts`, generated into `omni-sync-types`.
//!
//! On macOS the work is done by `omni-sync`, the Swift helper beside the app's executable
//! (`apps/desktop/macos`): it registers the File Provider domain, keeps the
//! token in the keychain group the extension reads, and signals the extension. This module only
//! runs it and moves the window through sign-in. Elsewhere sync is not available yet.

#[cfg(target_os = "macos")]
mod helper;
#[cfg(target_os = "macos")]
mod keychain;

#[cfg(not(target_os = "macos"))]
use omni_sync_types::DesktopSyncState;
use omni_sync_types::{DesktopSyncStatus, DesktopWorkspaceSync};
use tauri::{AppHandle, Runtime};

/// The redirect the `omni-desktop` OAuth client is registered with.
pub const OAUTH_CALLBACK: &str = "omni://oauth/callback";

#[tauri::command]
pub async fn sync_status<R: Runtime>(app: AppHandle<R>) -> DesktopSyncStatus {
    #[cfg(target_os = "macos")]
    if let Ok(status) = helper::status(&app).await {
        return status;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    DesktopSyncStatus {
        available: false,
        workspaces: Vec::new(),
    }
}

/// Turns sync on for a workspace. Without a sync grant yet, the window goes to the server's
/// authorize page (the person is signed in there), the answer is `needs_attention`, and the
/// workspace is switched on once `oauth_callback` has the tokens.
#[tauri::command]
pub async fn sync_connect<R: Runtime>(
    app: AppHandle<R>,
    org_id: String,
) -> Result<DesktopWorkspaceSync, String> {
    #[cfg(target_os = "macos")]
    return helper::connect(&app, org_id).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(format!("sync is not available in this build ({org_id})"))
    }
}

/// Turns sync off for a workspace: its folder leaves this computer, nothing leaves the server.
#[tauri::command]
pub async fn sync_disconnect(org_id: String) -> Result<DesktopWorkspaceSync, String> {
    #[cfg(target_os = "macos")]
    return helper::disconnect(org_id).await;
    #[cfg(not(target_os = "macos"))]
    Ok(DesktopWorkspaceSync {
        org_id,
        state: DesktopSyncState::Off,
    })
}

/// For the shell's deep-link and navigation handlers: true for the sync sign-in's redirect,
/// which `oauth_callback` takes.
pub fn is_oauth_callback(url: &str) -> bool {
    url.starts_with(OAUTH_CALLBACK)
}

/// Finishes sync sign-in from `omni://oauth/callback?code=&state=`: stores the tokens, switches
/// on the workspace that asked, and takes the window back to where it was.
pub async fn oauth_callback<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return helper::finish_sign_in(&app, url).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, url);
        Ok(())
    }
}

/// Starts what keeps Finder current while the app runs: until the `storage.changed` socket is
/// held here, the extension is asked every 60 seconds to read the change feeds.
pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    helper::start(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}
