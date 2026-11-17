// Desktop notifications (S2): new mail and your notifications (assigned, mentioned, a note on a
// conversation you're in, a customer replied, SLA at risk or breached, a teammate joined) as
// system notifications, from every workspace you're in (`workspace-watch.ts`).
// Which kinds reach you at all is decided by the server (`member_preferences`); whether this
// browser shows them is a per-device choice, kept in localStorage beside the browser's own
// permission. Nothing here is sent to the server.
import { useSyncExternalStore } from "react";
import { currentWorkspaceId } from "./current-workspace.ts";
import { desktop } from "./desktop.ts";
import { notificationSubject, notificationTitle } from "./notification-text.ts";
import type { NotificationPage } from "./types.ts";

type Notice = NotificationPage["notifications"][number];

const STORAGE_KEY = "omni.desktop-notifications";

/** `unsupported`: no Notification API. `blocked`: the browser denied it. Else on or off here. */
export type DesktopNotificationState = "unsupported" | "blocked" | "on" | "off";

const listeners = new Set<() => void>();
const emit = () => {
  for (const notify of listeners) notify();
};

function readEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

const currentState: () => DesktopNotificationState = () => {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && readEnabled() ? "on" : "off";
};

export function useDesktopNotificationState() {
  return useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => listeners.delete(notify);
  }, currentState) satisfies DesktopNotificationState;
}

/** Turns them on (asking the browser first) or off for this device. Resolves the new state. */
export const setDesktopNotifications: (on: boolean) => Promise<DesktopNotificationState> = async (
  on,
) => {
  if (typeof Notification === "undefined") return "unsupported";
  if (on && Notification.permission === "default") await Notification.requestPermission();
  try {
    if (on && Notification.permission === "granted") localStorage.setItem(STORAGE_KEY, "on");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the switch reads off again, which is the truth.
  }
  emit();
  return currentState();
};

/**
 * Whether Omni is out of sight. A tab is when another tab or app covers it. The desktop app's
 * window can stay visible behind other apps, so there it is whenever another app has the focus.
 */
const inBackground = () =>
  desktop.isDesktop ? !document.hasFocus() : document.visibilityState !== "visible";

/**
 * Whether news from workspace `orgId` should be shown now: notifications are on here, and Omni
 * is in the background or on screen in another workspace (nothing on screen shows it then).
 */
export const shouldShow = (orgId: string) =>
  currentState() === "on" && (inBackground() || orgId !== currentWorkspaceId());

/** Threads notified about lately: new mail and a "customer replied" about it are one notification. */
const recentThreads = new Map<string, number>();
const SAME_NEWS_MS = 30_000;

/** True the first time `threadId` is claimed within `SAME_NEWS_MS`; null threads always are. */
export function claimThread(threadId: string | null, now = Date.now()) {
  if (!threadId) return true;
  for (const [id, at] of recentThreads) if (now - at > SAME_NEWS_MS) recentThreads.delete(id);
  if (recentThreads.has(threadId)) return false;
  recentThreads.set(threadId, now);
  return true;
}

/**
 * Shows one system notification. In the desktop app it is the notification plugin's, whose
 * clicks the shell reports; in a browser, the Notification API's. `tag` keeps two tabs showing
 * the same news to one notification. A click brings Omni forward and runs `open`.
 */
export function showNotification(
  notice: { tag: string; title: string; body: string },
  open: () => void,
) {
  if (desktop.isDesktop) return desktop.notify(notice, open);
  const shown = new Notification(notice.title, { body: notice.body, tag: notice.tag });
  shown.addEventListener("click", () => {
    window.focus();
    open();
    shown.close();
  });
}

/**
 * Remembers which notifications of workspace `orgId` it has seen, and shows the new unread ones.
 * The first list only sets the baseline, so opening Omni never replays old ones.
 */
export function createNotifier(orgId: string, open: (notice: Notice) => void) {
  let seen: Set<string> | null = null;
  return (notices: readonly Notice[]) => {
    const fresh = seen ? notices.filter((n) => !n.readAt && !seen?.has(n.id)) : [];
    seen = new Set([...(seen ?? []), ...notices.map((n) => n.id)]);
    if (!shouldShow(orgId)) return;
    for (const notice of fresh) {
      // Only "customer replied" says the same as the mail arriving; the rest are news of their own.
      if (notice.kind === "customer_reply" && !claimThread(notice.threadId)) continue;
      showNotification(
        {
          tag: notice.id,
          title: notificationTitle(notice),
          body: notificationSubject(notice) ?? "",
        },
        () => open(notice),
      );
    }
  };
}
