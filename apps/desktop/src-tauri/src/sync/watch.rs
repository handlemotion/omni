//! Keeps Finder current within seconds while the app runs, window open or not: one
//! `storage.changed` socket per synced workspace (`/api/storage/sync/:orgId/realtime`, with the
//! sync grant's bearer token), each message signalling the extension. While any socket is down,
//! the extension is still signalled every 60 seconds, as before there were sockets.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::async_runtime::{self, JoinHandle};
use tauri::{AppHandle, Manager, Runtime, Url};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use super::{helper, keychain};
use crate::server::Server;

/// How often the synced workspaces are read again, to open or close sockets.
const RECONCILE: Duration = Duration::from_secs(30);
/// How often the extension is signalled while a socket is down.
const POLL: Duration = Duration::from_secs(60);
/// The first wait before a socket is tried again; it doubles up to `MOST_BACKOFF`.
const LEAST_BACKOFF: Duration = Duration::from_secs(1);
const MOST_BACKOFF: Duration = Duration::from_secs(60);
/// A socket that stayed up this long starts its next wait from `LEAST_BACKOFF` again.
const STEADY: Duration = Duration::from_secs(60);
/// Signals closer together than this are one: a folder dropped on the web app is a burst.
const COALESCE: Duration = Duration::from_millis(500);

/// The workspaces whose socket is open now.
#[derive(Clone, Default)]
struct Open(Arc<Mutex<HashSet<String>>>);

impl Open {
    fn set(&self, org_id: &str, open: bool) {
        let mut set = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if open {
            set.insert(org_id.to_owned());
        } else {
            set.remove(org_id);
        }
    }

    fn cover(&self, org_ids: &[String]) -> bool {
        let set = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        org_ids.iter().all(|org_id| set.contains(org_id))
    }
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    async_runtime::spawn(async move { supervise(app).await });
}

/// Opens a socket for each synced workspace and closes the rest, and polls while any is down.
async fn supervise<R: Runtime>(app: AppHandle<R>) {
    let wake = Arc::new(Notify::new());
    async_runtime::spawn(signaller(Arc::clone(&wake)));
    let open = Open::default();
    let mut held: HashMap<String, (Url, JoinHandle<()>)> = HashMap::new();
    let mut polled = Instant::now();
    loop {
        let reading = app.clone();
        let synced = async_runtime::spawn_blocking(move || helper::synced(&reading))
            .await
            .unwrap_or_default();
        let origin = app
            .try_state::<Server>()
            .and_then(|server| server.current());
        held.retain(|org_id, (at, task)| {
            let keep = synced.contains(org_id) && origin.as_ref() == Some(at);
            if !keep {
                task.abort();
                open.set(org_id, false);
            }
            keep
        });
        if let Some(origin) = &origin {
            for org_id in &synced {
                if !held.contains_key(org_id) {
                    let task = async_runtime::spawn(hold(
                        app.clone(),
                        origin.clone(),
                        org_id.clone(),
                        open.clone(),
                        Arc::clone(&wake),
                    ));
                    held.insert(org_id.clone(), (origin.clone(), task));
                }
            }
        }
        if !synced.is_empty() && !open.cover(&synced) && polled.elapsed() >= POLL {
            wake.notify_one();
            polled = Instant::now();
        }
        tokio::time::sleep(RECONCILE.min(POLL)).await;
    }
}

/// Runs `omni-sync signal` once per wake, never two at once, a burst of wakes counting as one.
async fn signaller(wake: Arc<Notify>) {
    loop {
        wake.notified().await;
        tokio::time::sleep(COALESCE).await;
        let _ = async_runtime::spawn_blocking(helper::signal).await;
    }
}

/// Holds one workspace's socket for as long as the task runs, reconnecting with backoff.
async fn hold<R: Runtime>(
    app: AppHandle<R>,
    origin: Url,
    org_id: String,
    open: Open,
    wake: Arc<Notify>,
) {
    let mut backoff = LEAST_BACKOFF;
    loop {
        let opened = Instant::now();
        if let Some(socket) = connect(&app, &origin, &org_id).await {
            open.set(&org_id, true);
            // Whatever changed while the socket was down.
            wake.notify_one();
            let (_, mut incoming) = socket.split();
            while let Some(Ok(message)) = incoming.next().await {
                if message.is_text() || message.is_binary() {
                    wake.notify_one();
                }
            }
            open.set(&org_id, false);
        } else {
            // The token may have expired: the extension refreshes it on its next call.
            wake.notify_one();
        }
        if opened.elapsed() >= STEADY {
            backoff = LEAST_BACKOFF;
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MOST_BACKOFF);
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect<R: Runtime>(app: &AppHandle<R>, origin: &Url, org_id: &str) -> Option<Socket> {
    let tokens = keychain::read(app)?;
    let mut url = origin
        .join(&format!("/api/storage/sync/{org_id}/realtime"))
        .ok()?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).ok()?;
    let mut request = url.as_str().into_client_request().ok()?;
    let bearer = HeaderValue::from_str(&format!("Bearer {}", tokens.access_token)).ok()?;
    request.headers_mut().insert("authorization", bearer);
    tokio_tungstenite::connect_async(request)
        .await
        .ok()
        .map(|(socket, _)| socket)
}
