export type DesktopPlatform = "mac" | "windows" | "linux";

const inShell = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const readPlatform: () => DesktopPlatform = () => {
  const agent = navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(agent)) return "mac";
  if (/Windows/.test(agent)) return "windows";
  return "linux";
};

const bridge = () => import("./desktop-bridge.ts");

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
   * in this window and reloads. Each call is a new, single-use state.
   */
  signInCallback() {
    return bridge().then((b) => b.signInCallback()) satisfies Promise<string>;
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

  /**
   * Drive sync on this computer: the workspaces whose files the system's folder holds. Only the
   * macOS app has a provider yet; elsewhere `available` is false. Turning one on without a sync
   * grant takes this window through the server's authorize page and back.
   */
  sync: {
    status: () => bridge().then((b) => b.syncStatus()),
    connect: (orgId: string) => bridge().then((b) => b.syncConnect(orgId)),
    disconnect: (orgId: string) => bridge().then((b) => b.syncDisconnect(orgId)),
  },

  /**
   * A shell update downloaded and waiting to install: its version, `null` when there is none or
   * the shell predates updates it can report. `install` restarts into it.
   */
  update: {
    ready: () =>
      bridge()
        .then((b) => b.updateReady())
        .catch(() => null),
    install: () => run("update", (b) => b.updateInstall()),
    /** Calls `handler` once an update is downloaded; returns the unsubscribe. */
    onReady: (handler: (version: string) => void) => {
      const stop = bridge()
        .then((b) => b.onUpdateReady(handler))
        .catch(() => () => {});
      return () => void stop.then((unlisten) => unlisten());
    },
  },

  /** The Dock badge: a count, or none at zero. On Windows, the taskbar button's overlay icon. */
  setBadge(count: number) {
    if (desktop.platform === "windows") run("badge", (b) => b.setOverlayBadge(count));
    else run("badge", (b) => b.setBadge(count));
  },
};

const TITLE_BAR_PX = 48;

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

const OUTSIDE = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * The URL a click on a link should hand to the default browser, or null to leave the click to the
 * page. Links to another origin, and mail and phone links, open outside the app: the window is
 * the app, with no address bar or back button to return from someone else's site.
 */
export function outsideLink(event: MouseEvent) {
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
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("auxclick", onLinkClick, true);
}

function onLinkClick(event: MouseEvent) {
  const url = outsideLink(event);
  if (!url) return;
  event.preventDefault();
  desktop.openOutside(url);
}
