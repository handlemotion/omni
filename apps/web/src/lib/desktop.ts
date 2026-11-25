type DesktopPlatform = "mac" | "windows" | "linux";

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

  /**
   * The window's own minimize, maximize and close, drawn by the page on Windows in place of the
   * native frame (docs/spec/desktop.md, "Window"). `claim` takes the frame off and resolves true
   * once it is off; false elsewhere, and on a shell too old to allow it, which keeps its frame.
   */
  frame: {
    claim: () =>
      desktop.platform === "windows"
        ? bridge()
            .then((b) => b.dropFrame())
            .then(
              () => true,
              () => false,
            )
        : Promise.resolve(false),
    minimize: () => run("minimize", (b) => b.minimize()),
    toggleMaximize: () => run("maximize", (b) => b.toggleMaximize()),
    close: () => run("close", (b) => b.close()),
    /** Calls `handler` with whether the window is maximized; returns the unsubscribe. */
    onMaximized: (handler: (maximized: boolean) => void) => {
      const stop = bridge()
        .then((b) => b.onMaximized(handler))
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
 * Where a click on a link should go, or null to leave the click to the page. Links to another
 * origin, and mail and phone links, open outside the app: the window is the app, with no address
 * bar or back button to return from someone else's site. Links to the app's own pages that would
 * open a new window (`target="_blank"`, and every link in a message's frame) open in this window
 * instead: the shell sends new windows to the browser, so a Drive link an agent mailed would
 * otherwise open on the web. `/api/` links (attachments) are left to the page.
 */
export function linkRoute(event: MouseEvent, framed = false) {
  if (event.defaultPrevented || event.button > 1) return null;
  // WARNING: a frame's nodes come from another realm, where `instanceof Element` is false.
  const target = event.target as Partial<Element> | null;
  const anchor = target?.closest?.<HTMLAnchorElement | SVGAElement>("a[href]");
  if (!anchor || anchor.hasAttribute("download")) return null;
  const href = typeof anchor.href === "string" ? anchor.href : anchor.href.baseVal;
  let url: URL;
  try {
    url = new URL(href, anchor.baseURI);
  } catch {
    return null;
  }
  if (!OUTSIDE.has(url.protocol)) return null;
  if (url.origin !== window.location.origin) return { outside: url.toString() };
  if (!framed && anchor.getAttribute("target") !== "_blank") return null;
  if (url.pathname.startsWith("/api/")) return null;
  return { inside: `${url.pathname}${url.search}${url.hash}` };
}

let navigateInside = (path: string) => window.location.assign(path);

/**
 * In the desktop app, sends every outside link to the default browser on purpose, instead of
 * leaving it to the shell's navigation guard. That keeps the window's own navigations, the ones
 * the app starts with `location.assign` (Google connect, Stripe Checkout, Domain Connect), free
 * to be round trips that come back to the app. Links to the app's own pages that ask for a new
 * window go to `navigate` instead. Does nothing in a browser.
 */
export function routeLinks(navigate: (path: string) => void) {
  if (!inShell) return;
  navigateInside = navigate;
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("auxclick", onLinkClick, true);
}

/** `routeLinks` for a message's frame, whose clicks never reach this document; returns the undo. */
export function routeFrameLinks(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument;
  if (!inShell || !doc) return () => {};
  doc.addEventListener("click", onFrameLinkClick, true);
  doc.addEventListener("auxclick", onFrameLinkClick, true);
  return () => {
    doc.removeEventListener("click", onFrameLinkClick, true);
    doc.removeEventListener("auxclick", onFrameLinkClick, true);
  };
}

const onLinkClick = (event: MouseEvent) => followLink(event, linkRoute(event));
const onFrameLinkClick = (event: MouseEvent) => followLink(event, linkRoute(event, true));

function followLink(event: MouseEvent, route: ReturnType<typeof linkRoute>) {
  if (!route) return;
  event.preventDefault();
  if (route.outside !== undefined) desktop.openOutside(route.outside);
  else navigateInside(route.inside);
}
