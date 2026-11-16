//! Where a URL the main window is asked to load goes (ADR 0043 decision 2, docs/spec/desktop.md
//! "The shell"). Web pages load in the window: only the chosen server's origin holds the remote
//! capability, so another origin's page or frame can call nothing. They have to load there:
//! WebKit asks this same hook for every subframe (Stripe Elements), and the app's round trips
//! through another origin (Google connect, Stripe Checkout) keep their state in the window's
//! cookies. Link clicks to other origins never get here: the web app hands them to the opener.
//! `mailto:` and `tel:` go to their apps; any other scheme is dropped. Pure, so tested without a
//! window.

use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destination {
    /// Load it in the window.
    Window,
    /// Cancel it and hand it to the default mail or phone app (or browser, for a new window).
    Browser,
    /// Cancel it: a scheme nothing should open from here (`file:`, `javascript:`, …).
    Drop,
}

/// The origins the bundled shell is served from: Tauri's scheme on macOS and Linux, its
/// `tauri.localhost` host on Windows, and the Vite server in `tauri dev`.
pub fn local_origins(dev_url: Option<&Url>) -> Vec<Url> {
    let mut origins: Vec<Url> = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]
    .iter()
    .filter_map(|origin| Url::parse(origin).ok())
    .collect();
    origins.extend(dev_url.cloned());
    origins
}

/// Same scheme, host and port. `Url::origin` cannot be used: Tauri's own scheme has an opaque
/// origin, and two opaque origins never compare equal.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Where `url` goes. The bundled shell's own scheme is allowed by origin; the chosen server
/// needs no special case, it is a web page like any other here.
pub fn destination(url: &Url, local: &[Url]) -> Destination {
    if local.iter().any(|origin| same_origin(url, origin)) {
        return Destination::Window;
    }
    match url.scheme() {
        "http" | "https" | "blob" => Destination::Window,
        "about" if url.path() == "blank" => Destination::Window,
        "mailto" | "tel" => Destination::Browser,
        _ => Destination::Drop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn local() -> Vec<Url> {
        local_origins(Some(&url("http://localhost:1420")))
    }

    // Bug: Tauri's own scheme has an opaque origin; comparing `Url::origin` would drop the
    // bundled shell itself and leave the window blank on macOS and Linux.
    #[test]
    fn the_bundled_shell_stays_in_the_window() {
        for shell in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://localhost:1420/",
        ] {
            assert_eq!(
                destination(&url(shell), &local()),
                Destination::Window,
                "{shell}"
            );
        }
    }

    // Bug: WebKit asks the navigation hook for subframes too; sending other origins to the
    // browser removed Stripe's card iframe from Billing and opened a browser tab instead, and
    // broke Google connect, whose state cookie lives in the window.
    #[test]
    fn web_pages_and_frames_of_other_origins_load_in_the_window() {
        for page in [
            "https://js.stripe.com/v3/elements-inner-card.html",
            "https://accounts.google.com/o/oauth2/v2/auth?state=x",
            "blob:https://omni.example.com/3f1c",
            "about:blank",
        ] {
            assert_eq!(
                destination(&url(page), &local()),
                Destination::Window,
                "{page}"
            );
        }
    }

    // Bug: a `file:` or `javascript:` URL loaded in the window or handed to the opener would run
    // or reveal local files; a `mailto:` link would show an error page.
    #[test]
    fn unknown_schemes_are_dropped_and_mail_links_go_out() {
        assert_eq!(
            destination(&url("file:///etc/passwd"), &local()),
            Destination::Drop
        );
        assert_eq!(
            destination(&url("javascript:alert(1)"), &local()),
            Destination::Drop
        );
        assert_eq!(
            destination(&url("about:config"), &local()),
            Destination::Drop
        );
        assert_eq!(
            destination(&url("mailto:someone@example.com"), &local()),
            Destination::Browser
        );
        assert_eq!(
            destination(&url("tel:+15550100"), &local()),
            Destination::Browser
        );
    }
}
