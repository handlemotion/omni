//! The meeting recorder, as the page sees it (docs/spec/meetings.md, "The desktop recorder"):
//! commands the server origin calls, and the events it hears. Capture and the spool are the
//! `omni-recorder` crate; this module holds the one live recording, shows the pill, and keeps
//! the tray and the meeting-start notification in step.
//!
//! The page owns everything that needs the session: it asks for consent, calls
//! `POST /api/meetings`, then `recording_start`; once a recording is stopped (here, from the pill
//! or the tray, or by the page) it runs `finishRecording` from `@omni/client` over
//! `recording_list`, `recording_part`, `recording_mark` and `recording_discard`.

mod pill;
mod schedule;

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use omni_recorder::capture::{CaptureError, Source};
use omni_recorder::spool::{self, State as SpoolState};
use omni_recorder::{NewRecording, Recorder, StartError, find, recover_left};
use omni_sync_types::desktop_recorder::{
    Code, DesktopRecorderError, DesktopRecording, DesktopRecordingRequest,
    DesktopRecordingSchedule, DesktopRecordingStart, DesktopRecordingState, EventElement,
};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub use schedule::start as start_schedule;

/// Every recording's state, about four times a second while one captures.
pub const CHANGED_EVENT: &str = "recording-changed";
/// Asks the page to start a recording: tray "Record now". The page asks for consent first.
pub const REQUESTED_EVENT: &str = "recording-requested";
/// A calendar meeting with a video link just began: the page may offer Record for it.
pub const OFFERED_EVENT: &str = "recording-offered";

#[derive(Default)]
enum Slot {
    #[default]
    Idle,
    /// Capture is starting (on macOS, possibly waiting on a permission prompt). Its spool may
    /// already be on disk, so nothing is recovered meanwhile.
    Starting,
    Live(Recorder),
    /// The recording with this id is closing its file.
    Stopping(String),
}

#[derive(Default)]
pub struct Recording {
    slot: Mutex<Slot>,
    schedule: Mutex<Vec<EventElement>>,
}

fn error(code: Code, message: impl Into<String>) -> DesktopRecorderError {
    DesktopRecorderError {
        code,
        message: message.into(),
    }
}

fn failed(e: impl std::fmt::Display) -> DesktopRecorderError {
    error(Code::Failed, e.to_string())
}

fn root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, DesktopRecorderError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(failed)?
        .join("recordings"))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, DesktopRecorderError> + Send + 'static,
) -> Result<T, DesktopRecorderError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(failed)?
}

impl Recording {
    fn slot(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The spool the shell is writing to, which no command may read, recover or delete.
    fn live_id(&self) -> Option<String> {
        match &*self.slot() {
            Slot::Live(recorder) => Some(recorder.snapshot().id),
            Slot::Stopping(id) => Some(id.clone()),
            _ => None,
        }
    }

    pub fn is_busy(&self) -> bool {
        !matches!(*self.slot(), Slot::Idle)
    }
}

#[tauri::command]
pub async fn recording_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Recording>,
    recording: DesktopRecordingStart,
) -> Result<DesktopRecording, DesktopRecorderError> {
    {
        let mut slot = state.slot();
        if !matches!(*slot, Slot::Idle) {
            return Err(error(
                Code::AlreadyRecording,
                "a recording is already going",
            ));
        }
        *slot = Slot::Starting;
    }
    let root = root(&app)?;
    let notify = app.clone();
    let new = NewRecording {
        meeting_id: recording.meeting_id,
        member_id: recording.member_id,
        folder_id: recording.folder_id,
        title: recording.title,
    };
    let started = blocking(move || {
        Recorder::start(
            &root,
            new,
            Source::Device,
            Box::new(move |now| {
                let ended = now.state == DesktopRecordingState::Stopped;
                let now_id = now.id.clone();
                changed(&notify, now);
                // Capture that ended by itself (a device went away) retires its slot, pill and
                // tray item as Stop would. Only this recording: after a Stop, a newer recording
                // may already be live, and it must not be stopped.
                if ended {
                    let (app, id) = (notify.clone(), now_id);
                    tauri::async_runtime::spawn(async move {
                        let _ = stop_only(&app, Some(id)).await;
                    });
                }
            }),
        )
        .map_err(|e| match e {
            StartError::AlreadySpooled => error(
                Code::AlreadySpooled,
                "this meeting is already recorded on this computer",
            ),
            StartError::Capture(CaptureError::Unavailable) => {
                error(Code::Unavailable, CaptureError::Unavailable.to_string())
            }
            StartError::Capture(CaptureError::PermissionDenied(why)) => {
                error(Code::PermissionDenied, why)
            }
            StartError::Capture(CaptureError::Failed(why)) => failed(why),
            StartError::Io(e) => failed(e),
        })
    })
    .await;
    let mut slot = state.slot();
    match started {
        Ok(recorder) => {
            let now = recorder.snapshot();
            *slot = Slot::Live(recorder);
            drop(slot);
            pill::show(&app);
            crate::tray::set_recording(&app, true);
            changed(&app, now.clone());
            Ok(now)
        }
        Err(e) => {
            *slot = Slot::Idle;
            Err(e)
        }
    }
}

/// Whether leftovers may be recovered now. While a capture starts or stops, its spool is open
/// but not yet (or no longer) the live one, and recovering it would cut the file being written.
fn may_recover(slot: &Slot) -> bool {
    matches!(slot, Slot::Idle | Slot::Live(_))
}

#[tauri::command]
pub fn recording_pause(state: State<'_, Recording>) {
    if let Slot::Live(recorder) = &*state.slot() {
        recorder.pause();
    }
}

#[tauri::command]
pub fn recording_resume(state: State<'_, Recording>) {
    if let Slot::Live(recorder) = &*state.slot() {
        recorder.resume();
    }
}

/// Stops the live recording, if any, and answers it stopped, ready to finish.
pub async fn stop<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<DesktopRecording>, DesktopRecorderError> {
    stop_only(app, None).await
}

/// Whether a stop meant for `only` (any recording when `None`) applies to the live one.
fn applies_to(only: Option<&str>, live: &str) -> bool {
    only.is_none_or(|id| id == live)
}

/// Stops the live recording if it is `only` (or any, for `None`), checked and taken in one
/// hold of the slot.
async fn stop_only<R: Runtime>(
    app: &AppHandle<R>,
    only: Option<String>,
) -> Result<Option<DesktopRecording>, DesktopRecorderError> {
    let state = app.state::<Recording>();
    let recorder = {
        let mut slot = state.slot();
        match std::mem::take(&mut *slot) {
            Slot::Live(recorder) if applies_to(only.as_deref(), &recorder.snapshot().id) => {
                *slot = Slot::Stopping(recorder.snapshot().id);
                recorder
            }
            other => {
                *slot = other;
                return Ok(None);
            }
        }
    };
    pill::hide(app);
    crate::tray::set_recording(app, false);
    let stopped = blocking(move || recorder.stop().map_err(failed)).await;
    *state.slot() = Slot::Idle;
    stopped.map(Some)
}

#[tauri::command]
pub async fn recording_stop<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<DesktopRecording>, DesktopRecorderError> {
    stop(&app).await
}

/// Every recording on this computer: the live one, and those left to finish. Leftovers from a
/// crash or a quit are stopped first, so they come back ready to upload.
#[tauri::command]
pub async fn recording_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Recording>,
) -> Result<Vec<DesktopRecording>, DesktopRecorderError> {
    let (live, settled) = {
        let slot = state.slot();
        let live = match &*slot {
            Slot::Live(recorder) => Some(recorder.snapshot()),
            _ => None,
        };
        (live, may_recover(&slot))
    };
    let root = root(&app)?;
    let live_id = live.as_ref().map(|r| r.id.clone());
    let mut all = blocking(move || {
        let spools = if settled {
            recover_left(&root, live_id.as_deref())
        } else {
            spool::list(&root)
        }
        .map_err(failed)?;
        Ok(spools
            .iter()
            .filter(|s| Some(&s.manifest.id) != live_id.as_ref())
            .filter(|s| s.manifest.state == SpoolState::Stopped)
            .map(|s| s.snapshot(-120.0))
            .collect::<Vec<_>>())
    })
    .await?;
    all.extend(live);
    Ok(all)
}

/// Part `partNumber` (from 1) of a stopped recording, as raw bytes for Drive's upload.
#[tauri::command]
pub async fn recording_part<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Recording>,
    id: String,
    part_number: u64,
    part_size: u64,
) -> Result<Response, DesktopRecorderError> {
    if state.live_id().as_ref() == Some(&id) {
        return Err(failed("the recording is still going"));
    }
    let root = root(&app)?;
    let bytes = blocking(move || {
        find(&root, &id)
            .and_then(|spool| spool.read_part(part_number, part_size))
            .map_err(failed)
    })
    .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn recording_mark<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    upload_id: Option<String>,
    node_id: Option<String>,
) -> Result<(), DesktopRecorderError> {
    let root = root(&app)?;
    blocking(move || {
        find(&root, &id)
            .and_then(|mut spool| spool.mark(upload_id, node_id))
            .map_err(failed)
    })
    .await
}

/// Deletes a stopped recording's spool, once the meeting has its file.
#[tauri::command]
pub async fn recording_discard<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Recording>,
    id: String,
) -> Result<(), DesktopRecorderError> {
    if state.live_id().as_ref() == Some(&id) {
        return Err(failed("the recording is still going"));
    }
    let root = root(&app)?;
    blocking(move || {
        find(&root, &id)
            .and_then(|spool| spool.remove())
            .map_err(failed)
    })
    .await
}

/// The page's upcoming calendar meetings, replacing the last list.
#[tauri::command]
pub fn recording_schedule(state: State<'_, Recording>, schedule: DesktopRecordingSchedule) {
    *state
        .schedule
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = schedule.events;
}

fn changed<R: Runtime>(app: &AppHandle<R>, now: DesktopRecording) {
    let _ = app.emit(CHANGED_EVENT, now);
}

/// Tray "Record now": the page asks for consent and starts it.
pub fn request<R: Runtime>(app: &AppHandle<R>) {
    crate::window::show(app);
    let _ = app.emit_to(
        "main",
        REQUESTED_EVENT,
        DesktopRecordingRequest { event: None },
    );
}

/// Quitting while recording closes the file properly instead of leaving it to recovery.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<Recording>()
        && let Slot::Live(recorder) = std::mem::take(&mut *state.slot())
    {
        let _ = recorder.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bug: listing while macOS waits on a permission prompt, or while Stop closes the file,
    // "recovered" the spool being written: its file was cut and marked stopped mid-recording.
    #[test]
    fn nothing_is_recovered_while_a_capture_starts_or_stops() {
        assert!(!may_recover(&Slot::Starting));
        assert!(!may_recover(&Slot::Stopping("spool".into())));
        assert!(may_recover(&Slot::Idle));
    }

    // Bug: a Stop's own stopped event scheduled a second stop; when a new recording had started
    // meanwhile, that second stop ended the new one and hid its pill.
    #[test]
    fn a_capture_ending_retires_only_itself() {
        assert!(applies_to(Some("old"), "old"));
        assert!(!applies_to(Some("old"), "new"));
        assert!(applies_to(None, "new"));
    }
}
