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
  } catch {}
  emit();
  return currentState();
};

const inBackground = () =>
  desktop.isDesktop ? !document.hasFocus() : document.visibilityState !== "visible";

/**
 * Whether news from workspace `orgId` should be shown now: notifications are on here, and Omni
 * is in the background or on screen in another workspace (nothing on screen shows it then).
 */
export const shouldShow = (orgId: string) =>
  currentState() === "on" && (inBackground() || orgId !== currentWorkspaceId());

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
