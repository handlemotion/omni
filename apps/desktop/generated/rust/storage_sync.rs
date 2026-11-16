// Generated from @omni/contracts by packages/contracts/scripts/native-types.ts.
// Do not edit: run `pnpm --filter @omni/contracts native-types`.

use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageListResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<StorageNodeView>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,

    pub nodes: Vec<StorageNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageNodeView {
    pub node: StorageNode,

    pub path: Vec<Path>,

    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_version: Option<i64>,

    pub created_at: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_member_id: Option<String>,

    pub id: String,

    pub kind: Kind,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked_at: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    pub name: String,

    pub org_id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_member_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,

    pub size: i64,

    pub space: Space,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<String>,

    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    File,

    Folder,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Space {
    Personal,

    Shared,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Path {
    pub id: String,

    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Editor,

    Member,

    Viewer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageNodeResponse {
    pub node: StorageNode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCreateFolderBody {
    pub name: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<Space>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageChangeNodeBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<Space>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOpenUploadBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    pub name: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,

    pub size: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<Space>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReplaceUploadBody {
    pub if_content_version: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    pub replaces: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,

    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageUploadResponse {
    pub upload: Upload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub expires_at: String,

    pub id: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,

    pub name: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    pub part_count: i64,

    pub parts: Vec<Part>,

    pub part_size: i64,

    pub size: i64,

    pub space: Space,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub part_number: i64,

    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowance_bytes: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_bytes: Option<f64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub overage: Option<Overage>,

    pub reserved_bytes: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploads_blocked: Option<UploadsBlocked>,

    pub used_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overage {
    pub extra_gb: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadsBlocked {
    #[serde(rename = "billing_inactive")]
    BillingInactive,

    #[serde(rename = "storage_full")]
    StorageFull,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageSyncDrivesResponse {
    pub workspaces: Vec<StorageSyncWorkspace>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSyncWorkspace {
    pub drives: Vec<StorageSyncDrive>,

    pub name: String,

    pub org_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageSyncDrive {
    pub revision: i64,

    pub space: Space,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSyncChangesResponse {
    pub changes: Vec<StorageSyncChange>,

    pub more: bool,

    pub next_cursor: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSyncChange {
    pub id: String,

    pub in_trash: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<StorageNode>,

    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorageChangedEvent {
    pub space: Space,

    #[serde(rename = "type")]
    pub storage_changed_event_type: Type,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Type {
    #[serde(rename = "storage.changed")]
    StorageChanged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopSyncStatus {
    pub available: bool,

    pub workspaces: Vec<DesktopWorkspaceSync>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkspaceSync {
    pub org_id: String,

    pub state: DesktopSyncState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopSyncState {
    #[serde(rename = "needs_attention")]
    NeedsAttention,

    Off,

    Paused,

    Synced,

    Syncing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopSyncSignIn {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopSyncDone {
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncTokens {
    pub access_token: String,

    pub expires_at: f64,

    pub refresh_token: String,
}
