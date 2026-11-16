//! Drive sync, as the web app sees it (ADR 0043 decision 2): the three commands the server
//! origin may call. Settings → Drive reads `sync_status` and switches a workspace with
//! `sync_connect` / `sync_disconnect`. Their shapes are `desktopSyncStatusSchema` and
//! `desktopWorkspaceSyncSchema` in `@omni/contracts`, generated into `omni-sync-types`.
//!
//! Scaffold: the shapes are final, the behaviour is not. The File Provider layer registers the
//! domain, holds the `storage:sync` token in the keychain and signals the extension here.

use omni_sync_types::{DesktopSyncStatus, DesktopWorkspaceSync};

#[tauri::command]
pub fn sync_status() -> DesktopSyncStatus {
    DesktopSyncStatus {
        available: false,
        workspaces: Vec::new(),
    }
}

#[tauri::command]
pub fn sync_connect(org_id: String) -> Result<DesktopWorkspaceSync, String> {
    Err(format!("sync is not available in this build ({org_id})"))
}

#[tauri::command]
pub fn sync_disconnect(org_id: String) -> Result<DesktopWorkspaceSync, String> {
    Err(format!("sync is not available in this build ({org_id})"))
}
