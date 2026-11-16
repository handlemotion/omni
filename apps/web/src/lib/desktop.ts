// The desktop app (ADR 0043, docs/spec/desktop.md "Navigation changes in the web app"): the same
// build, loaded by a Tauri window from this server's origin. This is the only file that knows
// Tauri exists; everything else reads `desktop`. Tauri's JS API loads by dynamic import
// (`desktop-bridge.ts`), so the browser bundle never carries it.
//
// What the window may call is the shell's remote capability (`REMOTE_PERMISSIONS` in
// `apps/desktop/src-tauri/src/server.rs`). Anything not listed there fails here.

export type DesktopPlatform = "mac" | "windows" | "linux";

// Tauri injects its IPC object into every page its window loads, before any of ours runs.
const inShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function readPlatform(): DesktopPlatform {
  const agent = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(agent)) return "mac";
  if (/Windows/.test(agent)) return "windows";
  return "linux";
}

const bridge = () => import("./desktop-bridge.ts");

/** A failed call to the shell is logged, never thrown: the page works without it. */
function run(what: string, call: (b: Awaited<ReturnType<typeof bridge>>) => Promise<unknown>) {
  void bridge()
    .then(call)
    .catch((error: unknown) => console.warn(`desktop: ${what} failed`, error));
}

export const desktop = {
  isDesktop: inShell,
  platform: inShell ? readPlatform() : null,

  /** Opens `url` in the default browser (or mail app, for `mailto:`). */
  openOutside(url: string) {
    run("open", (b) => b.openOutside(url));
  },

  /**
   * Where a magic link sent from the desktop app ends: the shell's `omni://auth?state=…`. The
   * link opens in the default browser; the Worker sends the session there, and the shell puts it
   * in this window and reloads (ADR 0043 decision 5). Each call is a new, single-use state.
   */
  signInCallback(): Promise<string> {
    return bridge().then((b) => b.signInCallback());
  },

  /**
   * A native notification. A click brings the window back (shown, in front) and runs `onClick`.
   */
  notify(notice: { title: string; body: string }, onClick: () => void) {
    run("notify", (b) =>
      b.notify(notice.title, notice.body, () => {
        run("focus", (shell) => shell.focusWindow());
        onClick();
      }),
    );
  },

  /** The Dock badge: a count, or none at zero. macOS and Linux; Windows has no count badge. */
  setBadge(count: number) {
    run("badge", (b) => b.setBadge(count));
  },
};

/** The title bar's height: the page headers' 48px row, which is also the window's drag region. */
const TITLE_BAR_PX = 48;

// What a press in the title bar row works instead of moving the window.
const CONTROL = "button, a, input, textarea, select, label, [role], [contenteditable]";

/**
 * In the desktop app, the top row of every screen moves the window, as a title bar does, except
 * on its controls; a double click zooms it (docs/spec/desktop.md, "Navigation changes in the web
 * app"). One listener here, rather than a drag attribute on each screen's header.
 */
export function routeTitleBarDrags() {
  if (!inShell) return;
  document.addEventListener("mousedown", onTitleBarPress);
}

function onTitleBarPress(event: MouseEvent) {
  if (event.button !== 0 || event.clientY > TITLE_BAR_PX || event.defaultPrevented) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(CONTROL)) return;
  event.preventDefault();
  if (event.detail === 2) run("zoom", (b) => b.toggleMaximize());
  else run("drag", (b) => b.startDragging());
}

/** Schemes the default browser or mail app should get rather than this window. */
const OUTSIDE = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * The URL a click on a link should hand to the default browser, or null to leave the click to the
 * page. Links to another origin, and mail and phone links, open outside the app: the window is
 * the app, with no address bar or back button to return from someone else's site.
 */
export function outsideLink(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button > 1) return null;
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest<HTMLAnchorElement | SVGAElement>("a[href]");
  if (!anchor || anchor.hasAttribute("download")) return null;
  const href = anchor instanceof HTMLAnchorElement ? anchor.href : anchor.href.baseVal;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (!OUTSIDE.has(url.protocol) || url.origin === window.location.origin) return null;
  return url.toString();
}

/**
 * In the desktop app, sends every outside link to the default browser on purpose, instead of
 * leaving it to the shell's navigation guard. That keeps the window's own navigations, the ones
 * the app starts with `location.assign` (Google connect, Stripe Checkout, Domain Connect), free
 * to be round trips that come back to the app. Does nothing in a browser.
 */
export function routeOutsideLinks() {
  if (!inShell) return;
  // Capture, so a link inside a component that stops propagation is still routed. Middle clicks
  // arrive as `auxclick`.
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("auxclick", onLinkClick, true);
}

function onLinkClick(event: MouseEvent) {
  const url = outsideLink(event);
  if (!url) return;
  event.preventDefault();
  desktop.openOutside(url);
}
