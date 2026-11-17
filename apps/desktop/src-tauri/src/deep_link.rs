//! `omni://` links (docs/spec/desktop.md, decision 5 and "Links").
//!
//! - `omni://auth?state=…&cookie=…`: the end of a magic-link sign-in. The link opens in the
//!   default browser; the Worker verifies it and redirects to the callback the window asked for,
//!   and Better Auth's `expo` plugin adds the session's `Set-Cookie` as `cookie`. The cookie goes
//!   into the window's cookie store for the server origin, then the window reloads.
//! - `omni://open?path=/inbox/…`: show that page of the server in the window.
//! - `omni://oauth/callback?code=…&state=…`: the end of storage sync's sign-in, handed to
//!   `sync::oauth_callback`.
//!
//! Any site can open an `omni://` URL, so a session is only taken with a `state` this app handed
//! out (`sign_in_callback`) and not yet used. Without it, a page could sign the window in to an
//! account of the attacker's choosing.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, Runtime, State};
use url::Url;

use crate::server::Server;

/// The URL scheme, as registered in `tauri.conf.json` (`plugins.deep-link`).
pub const SCHEME: &str = "omni";
/// How long a sign-in may take between asking for the link and opening it.
const STATE_TTL: Duration = Duration::from_secs(60 * 60);
/// Sign-ins in flight at once; the oldest is forgotten past this.
const MAX_STATES: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum Link {
    SignIn {
        state: String,
        set_cookie: String,
    },
    /// The Worker refused the link (expired or used): show the sign-in page again.
    SignInFailed,
    Open {
        path: String,
    },
    /// Ours, but nothing to do beyond bringing the window forward.
    Other,
}

pub fn parse(url: &Url) -> Option<Link> {
    if url.scheme() != SCHEME {
        return None;
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    Some(match url.host_str() {
        Some("auth") if param("error").is_some() => Link::SignInFailed,
        Some("auth") => match (param("state"), param("cookie")) {
            (Some(state), Some(set_cookie)) => Link::SignIn { state, set_cookie },
            _ => Link::SignInFailed,
        },
        Some("open") => match param("path") {
            Some(path) if is_app_path(&path) => Link::Open { path },
            _ => Link::Other,
        },
        _ => Link::Other,
    })
}

/// A path on the server, never a way off it: `//host` and `/\host` are other origins to a
/// browser.
pub fn is_app_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && !path.contains('\\')
}

/// `path` resolved against the server, if it stays on the server's origin. `Url::join` drops tabs
/// and newlines, so `/\n/evil.example` would otherwise become `//evil.example`.
pub fn on_server(server: &Url, path: &str) -> Option<Url> {
    let url = server.join(path).ok()?;
    (url.origin() == server.origin()).then_some(url)
}

/// The cookies in a `Set-Cookie` value as `Headers.get` joins them (`a=1; Path=/, b=2`), scoped
/// to the server's host. A comma inside `Expires=Wed, 21 Oct …` is not a separator: what follows
/// it is not `name=`.
pub fn cookies_for(set_cookie: &str, server: &Url) -> Vec<Cookie<'static>> {
    let mut parts: Vec<String> = Vec::new();
    for piece in set_cookie.split(',') {
        let starts_cookie = piece
            .trim_start()
            .split_once('=')
            .is_some_and(|(name, _)| !name.is_empty() && !name.contains([';', ' ']));
        match parts.last_mut() {
            Some(last) if !starts_cookie => {
                last.push(',');
                last.push_str(piece);
            }
            _ => parts.push(piece.trim_start().to_owned()),
        }
    }
    let host = server.host_str().unwrap_or_default().to_owned();
    parts
        .into_iter()
        .filter_map(|part| Cookie::parse(part).ok())
        .map(|mut cookie| {
            if cookie.domain().is_none() {
                cookie.set_domain(host.clone());
            }
            if cookie.path().is_none() {
                cookie.set_path("/");
            }
            cookie
        })
        .collect()
}

/// The `state`s handed out to sign-ins in flight.
#[derive(Default)]
pub struct SignIns(Mutex<Vec<(String, Instant)>>);

impl SignIns {
    fn issue(&self) -> String {
        let state = uuid::Uuid::new_v4().simple().to_string();
        let mut states = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        states.retain(|(_, at)| at.elapsed() < STATE_TTL);
        if states.len() >= MAX_STATES {
            states.remove(0);
        }
        states.push((state.clone(), Instant::now()));
        state
    }

    /// True once per issued, unexpired `state`.
    fn take(&self, state: &str) -> bool {
        let mut states = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let found = states
            .iter()
            .position(|(issued, at)| issued == state && at.elapsed() < STATE_TTL);
        if let Some(index) = found {
            states.remove(index);
        }
        states.retain(|(_, at)| at.elapsed() < STATE_TTL);
        found.is_some()
    }
}

/// The `callbackURL` the web app passes when it asks for a magic link in the desktop window.
#[tauri::command]
pub fn sign_in_callback(sign_ins: State<'_, SignIns>) -> String {
    format!("{SCHEME}://auth?state={}", sign_ins.issue())
}

/// Routes `omni://` URLs to `handle`. A link that starts the app arrives before a server is
/// chosen and only brings the window up; installed builds register the scheme, and debug builds
/// on Linux and Windows register it here so a second launch can deliver one.
pub fn listen<R: Runtime>(app: &tauri::App<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
    // Best effort: a debug build that cannot register still runs.
    #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
    if let Err(error) = app.deep_link().register_all() {
        eprintln!("could not register {SCHEME}:// for this debug build: {error}");
    }
    let handle = app.handle().clone();
    app.deep_link()
        .on_open_url(move |event| handle_urls(&handle, event.urls()));
}

/// Acts on `omni://` URLs from the deep-link plugin (cold start, or a second launch forwarded by
/// single-instance) and from the window's own navigations (`window::route`).
pub fn handle_urls<R: Runtime>(app: &AppHandle<R>, urls: Vec<Url>) {
    crate::window::show(app);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(server) = app.state::<Server>().current() else {
        return;
    };
    for url in urls
        .iter()
        .filter(|url| crate::sync::is_oauth_callback(url.as_str()))
    {
        // Storage sync's sign-in: the helper checks its own state and PKCE verifier.
        let (app, url) = (app.clone(), url.to_string());
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::sync::oauth_callback(app, url).await {
                eprintln!("sync sign-in did not finish: {error}");
            }
        });
    }
    for link in urls.iter().filter_map(parse) {
        match link {
            Link::SignIn { state, set_cookie } => {
                if !app.state::<SignIns>().take(&state) {
                    eprintln!("ignored a sign-in this app did not start");
                    continue;
                }
                let cookies = cookies_for(&set_cookie, &server);
                let (window, server) = (window.clone(), server.clone());
                // Cookie calls block on the webview's main thread: never make them from it.
                std::thread::spawn(move || {
                    for cookie in cookies {
                        if let Err(error) = window.set_cookie(cookie) {
                            eprintln!("could not keep the session: {error}");
                        }
                    }
                    let _ = window.navigate(server);
                });
            }
            Link::SignInFailed => {
                let _ = window.navigate(server.clone());
            }
            Link::Open { path } => {
                if let Some(url) = on_server(&server, &path) {
                    let _ = window.navigate(url);
                }
            }
            Link::Other => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    // Bug: an `open` link with `//evil.example` or `/\evil.example` would load another origin's
    // page through `Url::join`, outside the navigation guard's view of intent.
    #[test]
    fn open_links_stay_on_the_server() {
        assert_eq!(
            parse(&url("omni://open?path=%2Finbox%2Fabc%3Fview%3Dall")),
            Some(Link::Open {
                path: "/inbox/abc?view=all".into()
            })
        );
        for path in [
            "%2F%2Fevil.example",
            "%2F%5Cevil.example",
            "inbox",
            "https%3A%2F%2Fevil.example",
        ] {
            assert_eq!(
                parse(&url(&format!("omni://open?path={path}"))),
                Some(Link::Other),
                "{path}"
            );
        }
        assert_eq!(parse(&url("https://open?path=/inbox")), None);
    }

    // Bug: `/%0A/evil.example` passes the path check, and `Url::join` strips the newline, giving
    // `//evil.example`: the window would load another origin's page from an `omni://` link.
    #[test]
    fn an_open_link_resolves_only_on_the_server() {
        let server = url("https://omni.example.com/");
        let Some(Link::Open { path }) =
            parse(&url("omni://open?path=%2F%0A%2Fevil.example%2Flogin"))
        else {
            panic!("expected an open link");
        };
        assert_eq!(on_server(&server, &path), None);
        assert_eq!(
            on_server(&server, "/inbox/abc").map(String::from),
            Some("https://omni.example.com/inbox/abc".into())
        );
    }

    // Bug: a refused link (`?error=`) or one without a state would be read as a sign-in.
    #[test]
    fn only_a_complete_redirect_is_a_sign_in() {
        assert_eq!(
            parse(&url("omni://auth?state=s1&cookie=a%3D1")),
            Some(Link::SignIn {
                state: "s1".into(),
                set_cookie: "a=1".into()
            })
        );
        assert_eq!(
            parse(&url("omni://auth?state=s1&error=EXPIRED_TOKEN")),
            Some(Link::SignInFailed)
        );
        assert_eq!(
            parse(&url("omni://auth?cookie=a%3D1")),
            Some(Link::SignInFailed)
        );
    }

    // Bug: a page opening `omni://auth?state=guess&cookie=…` would sign the window in to the
    // attacker's account; and a used link replayed would do it again.
    #[test]
    fn a_state_signs_in_once_and_only_if_issued() {
        let sign_ins = SignIns::default();
        let state = sign_ins.issue();
        assert!(!sign_ins.take("guess"));
        assert!(sign_ins.take(&state));
        assert!(!sign_ins.take(&state));
    }

    // Bug: pruning an expired state shrank the list, so `take("guess")` returned true whenever
    // any sign-in had been left unfinished for an hour.
    #[test]
    fn an_expired_state_lets_no_guess_through() {
        let sign_ins = SignIns::default();
        sign_ins.0.lock().unwrap().push((
            "stale".into(),
            Instant::now() - STATE_TTL - Duration::from_secs(1),
        ));
        assert!(!sign_ins.take("guess"));
        assert!(!sign_ins.take("stale"));
    }

    // Bug: splitting the joined header on every comma breaks `Expires=Wed, 21 Oct …` into a
    // cookie named ` 21 Oct …`, and the session cookie loses its expiry or is dropped.
    #[test]
    fn joined_set_cookie_headers_split_into_cookies_for_the_server() {
        let header = "better-auth.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax, \
                      better-auth.session_data=xyz; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly";
        let cookies = cookies_for(header, &url("https://omni.example.com/"));
        let named: Vec<_> = cookies
            .iter()
            .map(|c| (c.name(), c.value(), c.domain(), c.path()))
            .collect();
        assert_eq!(
            named,
            [
                (
                    "better-auth.session_token",
                    "abc.def",
                    Some("omni.example.com"),
                    Some("/")
                ),
                (
                    "better-auth.session_data",
                    "xyz",
                    Some("omni.example.com"),
                    Some("/")
                ),
            ]
        );
        assert!(cookies[1].expires().is_some());
        assert_eq!(cookies[0].http_only(), Some(true));
    }
}
