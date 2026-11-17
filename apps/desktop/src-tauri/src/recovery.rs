//! A window whose page died comes back (docs/spec/desktop.md, "The shell"). macOS ends a
//! webview's content process under memory pressure, often while the Mac sleeps. wry answers
//! WebKit's `webViewWebContentProcessDidTerminate:` itself, so WebKit skips its own reload and the
//! window stays blank until the app is quit. Here the window goes back to the bundled page with
//! the page it showed: the bundled page waits for the server (a Mac just awake may have no network
//! yet), then opens that page again.
//!
//! A page that keeps dying (a bug that runs it out of memory) is not reopened in a loop: past
//! `MAX_RESUMES` in `WINDOW`, the bundled page shows its offline screen and waits for a click.
//!
//! macOS only: Tauri exposes the termination there alone. WebView2 and WebKitGTK report it
//! through events wry does not surface yet.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::{Manager, Runtime, Webview};
use url::Url;

use crate::navigation::same_origin;
use crate::server::Server;
use crate::window::LocalShell;

/// Terminations within this long count towards the limit.
const WINDOW: Duration = Duration::from_secs(60);
/// Pages reopened within `WINDOW`; the next termination stops on the offline screen.
const MAX_RESUMES: usize = 3;

static RECENT: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

/// The terminations still inside `WINDOW` at `now`, this one included, and whether to reopen.
fn record(history: &[Instant], now: Instant) -> (Vec<Instant>, bool) {
    let mut recent: Vec<Instant> = history
        .iter()
        .copied()
        .filter(|at| now.saturating_duration_since(*at) < WINDOW)
        .collect();
    let resume = recent.len() < MAX_RESUMES;
    recent.push(now);
    (recent, resume)
}

/// Where the bundled page should take the window back to: the dead page's path, query and
/// fragment when it was on the chosen server; nothing when it was the bundled page itself.
fn resume_path(page: &Url, server: &Url) -> Option<String> {
    if !same_origin(page, server) {
        return None;
    }
    let mut path = page.path().to_owned();
    if let Some(query) = page.query() {
        path.push('?');
        path.push_str(query);
    }
    if let Some(fragment) = page.fragment() {
        path.push('#');
        path.push_str(fragment);
    }
    Some(path)
}

/// The bundled page's URL for after a termination: `?resume=<path>` to reopen that page, or
/// `?offline` to stop on the offline screen.
fn shell_url(shell: &Url, resume: Option<String>, give_up: bool) -> Url {
    let mut url = shell.clone();
    url.set_fragment(None);
    url.set_query(None);
    if give_up {
        url.set_query(Some("offline"));
    } else if let Some(path) = resume {
        url.query_pairs_mut().append_pair("resume", &path);
    }
    url
}

/// The hook `Builder::on_web_content_process_terminate` calls (`lib.rs`).
pub fn on_terminate<R: Runtime>(webview: &Webview<R>) {
    let app = webview.app_handle();
    let (recent, resume) = record(
        &RECENT.lock().unwrap_or_else(PoisonError::into_inner),
        Instant::now(),
    );
    *RECENT.lock().unwrap_or_else(PoisonError::into_inner) = recent;

    let page = webview.url().ok();
    let server = app.state::<Server>().current();
    let path = page
        .as_ref()
        .zip(server.as_ref())
        .and_then(|(page, server)| resume_path(page, server));
    let target = shell_url(&app.state::<LocalShell>().0, path, !resume);
    eprintln!("the window's page ended; reopening it from {target}");
    // Off WebKit's delegate callback: navigating re-enters the webview.
    let webview = webview.clone();
    std::thread::spawn(move || {
        if let Err(error) = webview.navigate(target) {
            eprintln!("could not reopen the window's page: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bug: a page that runs out of memory as soon as it loads would be reopened forever, the app
    // pinned at full CPU instead of stopping on the offline screen.
    #[test]
    fn a_page_that_keeps_dying_stops_being_reopened() {
        let start = Instant::now();
        let mut history = Vec::new();
        let mut resumed = Vec::new();
        for second in [0, 1, 2, 3] {
            let (next, resume) = record(&history, start + Duration::from_secs(second));
            history = next;
            resumed.push(resume);
        }
        assert_eq!(resumed, [true, true, true, false]);
        // A minute later it is an ordinary termination again (a second night's sleep).
        let (_, resume) = record(&history, start + Duration::from_secs(64));
        assert!(resume);
    }

    // Bug: the window would come back on the Inbox instead of the folder or thread it showed, or
    // a page of another origin (a Stripe frame's window) would be opened on the server.
    #[test]
    fn the_server_page_shown_is_the_one_reopened() {
        let server = Url::parse("https://omni.example.com/").unwrap();
        let page = Url::parse("https://omni.example.com/acme/files/my/f1?mailbox=a#x").unwrap();
        assert_eq!(
            resume_path(&page, &server).as_deref(),
            Some("/acme/files/my/f1?mailbox=a#x")
        );
        let other = Url::parse("https://checkout.stripe.com/pay").unwrap();
        assert_eq!(resume_path(&other, &server), None);

        let shell = Url::parse("tauri://localhost/index.html?pick").unwrap();
        let url = shell_url(&shell, resume_path(&page, &server), false);
        let resume = url
            .query_pairs()
            .find(|(k, _)| k == "resume")
            .map(|(_, v)| v.into_owned());
        assert_eq!(resume.as_deref(), Some("/acme/files/my/f1?mailbox=a#x"));
        assert_eq!(
            shell_url(&shell, Some("/x".into()), true).query(),
            Some("offline")
        );
    }
}
