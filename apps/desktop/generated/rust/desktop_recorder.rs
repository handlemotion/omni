// Generated from @omni/contracts by packages/contracts/scripts/native-types.ts.
// Do not edit: run `pnpm --filter @omni/contracts native-types`.

use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRecording {
    pub cuts: Vec<Cut>,

    pub duration_ms: i64,

    pub folder_id: String,

    pub id: String,

    pub meeting_id: String,

    pub member_id: String,

    pub mic_db: f64,

    pub mic_spans: Vec<MicSpan>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,

    pub size: i64,

    pub started_at_ms: i64,

    pub state: DesktopRecordingState,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cut {
    pub at_ms: i64,

    pub dropped_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicSpan {
    pub end_ms: i64,

    pub start_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopRecordingState {
    Paused,

    Recording,

    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopRecorderError {
    pub code: Code,

    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    #[serde(rename = "already_recording")]
    AlreadyRecording,

    #[serde(rename = "already_spooled")]
    AlreadySpooled,

    Failed,

    #[serde(rename = "permission_denied")]
    PermissionDenied,

    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopRecordingRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<DesktopRecordingRequestEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRecordingRequestEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,

    pub recurring: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    pub uid: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopRecordingSchedule {
    pub events: Vec<EventElement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventElement {
    pub ends_at_ms: i64,

    pub has_video_link: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,

    pub recurring: bool,

    pub starts_at_ms: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,

    pub uid: String,
}
