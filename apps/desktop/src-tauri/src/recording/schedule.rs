//! "Record Week Kickoff?" (docs/spec/meetings.md, "How people use it"): when a calendar meeting
//! with a video link begins and the app is open, a notification offers to record it, and the page
//! hears `recording-offered` so it can show Record. It never starts a recording by itself.

use std::collections::HashSet;
use std::sync::PoisonError;
use std::time::Duration;

use omni_sync_types::desktop_recorder::{
    DesktopRecordingRequest, DesktopRecordingRequestEvent, EventElement,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use super::{OFFERED_EVENT, Recording};

const CHECK_EVERY: Duration = Duration::from_secs(15);
/// How long after a meeting begins it is still offered: someone who opens the app two minutes
/// late is still asked, ten minutes late is not.
const OFFER_FOR_MS: i64 = 5 * 60_000;

type Key = (String, Option<String>);

fn key(event: &EventElement) -> Key {
    (event.id.clone(), event.recurrence_id.clone())
}

/// The meetings to offer now: begun within the offer window, not over, with a video link, and
/// not offered before.
fn due<'a>(
    events: &'a [EventElement],
    now_ms: i64,
    offered: &HashSet<Key>,
) -> Vec<&'a EventElement> {
    events
        .iter()
        .filter(|e| e.has_video_link)
        .filter(|e| e.starts_at_ms <= now_ms && now_ms < e.starts_at_ms + OFFER_FOR_MS)
        .filter(|e| now_ms < e.ends_at_ms)
        .filter(|e| !offered.contains(&key(e)))
        .collect()
}

fn now_ms() -> i64 {
    omni_recorder::spool::now_ms() as i64
}

fn offer<R: Runtime>(app: &AppHandle<R>, offered: &mut HashSet<Key>) {
    let state = app.state::<Recording>();
    let events = state
        .schedule
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let now = now_ms();
    let due: Vec<EventElement> = due(&events, now, offered).into_iter().cloned().collect();
    for event in &due {
        offered.insert(key(event));
        if state.is_busy() {
            continue;
        }
        let title = event.title.as_deref().unwrap_or("this meeting");
        let shown = app
            .notification()
            .builder()
            .title("Omni")
            .body(format!("Record {title}?"))
            .show();
        if let Err(error) = shown {
            eprintln!("could not show a notification: {error}");
        }
        let request = DesktopRecordingRequest {
            event: Some(DesktopRecordingRequestEvent {
                id: event.id.clone(),
                recurrence_id: event.recurrence_id.clone(),
                title: event.title.clone(),
            }),
        };
        let _ = app.emit_to("main", OFFERED_EVENT, request);
    }
    // Forget what can never be due again, so the set stays small over weeks of uptime.
    offered.retain(|k| events.iter().any(|e| &key(e) == k && now < e.ends_at_ms));
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut offered = HashSet::new();
        let mut tick = tokio::time::interval(CHECK_EVERY);
        loop {
            tick.tick().await;
            offer(&app, &mut offered);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, starts_at_ms: i64, has_video_link: bool) -> EventElement {
        EventElement {
            id: id.into(),
            recurrence_id: None,
            title: Some("Week Kickoff".into()),
            starts_at_ms,
            ends_at_ms: starts_at_ms + 30 * 60_000,
            has_video_link,
        }
    }

    // Bug: offering a meeting before it begins, or an hour into it, nags about the wrong thing.
    #[test]
    fn a_meeting_is_offered_from_its_start_for_five_minutes() {
        let events = [event("a", 1_000_000, true)];
        let none = HashSet::new();
        assert!(due(&events, 999_999, &none).is_empty());
        assert_eq!(due(&events, 1_000_000, &none).len(), 1);
        assert_eq!(due(&events, 1_000_000 + OFFER_FOR_MS - 1, &none).len(), 1);
        assert!(due(&events, 1_000_000 + OFFER_FOR_MS, &none).is_empty());
    }

    // Bug: a check every 15 s would show the same notification twenty times.
    #[test]
    fn a_meeting_is_offered_once() {
        let events = [event("a", 0, true)];
        let offered = HashSet::from([key(&events[0])]);
        assert!(due(&events, 10, &offered).is_empty());
    }

    // Bug: a lunch block or a focus hour on the calendar is not a call to record.
    #[test]
    fn only_meetings_with_a_video_link_are_offered() {
        assert!(due(&[event("a", 0, false)], 10, &HashSet::new()).is_empty());
    }

    // Bug: two occurrences of one series share an event id; offering one must not hide the next.
    #[test]
    fn each_occurrence_is_its_own() {
        let mut first = event("a", 0, true);
        first.recurrence_id = Some("2026-11-16T10:00:00+01:00".into());
        let mut second = event("a", 0, true);
        second.recurrence_id = Some("2026-11-23T10:00:00+01:00".into());
        let offered = HashSet::from([key(&first)]);
        assert_eq!(due(&[first, second], 10, &offered).len(), 1);
    }
}
