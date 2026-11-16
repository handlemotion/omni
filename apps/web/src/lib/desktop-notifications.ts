// Desktop notifications (S2): your notifications (assigned, mentioned, a note on a conversation
// you're in, a customer replied, SLA at risk or breached, a teammate joined) as system notifications while Omni is in the background.
// Which kinds reach you at all is decided by the server (`member_preferences`); whether this
// browser shows them is a per-device choice, kept in localStorage beside the browser's own
// permission. Nothing here is sent to the server.
import { useSyncExternalStore } from "react";
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

function currentState(): DesktopNotificationState {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && readEnabled() ? "on" : "off";
}

export function useDesktopNotificationState(): DesktopNotificationState {
  return useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => listeners.delete(notify);
  }, currentState);
}

/** Turns them on (asking the browser first) or off for this device. Resolves the new state. */
export async function setDesktopNotifications(on: boolean): Promise<DesktopNotificationState> {
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
}

/**
 * Whether Omni is out of sight. A tab is when another tab or app covers it. The desktop app's
 * window can stay visible behind other apps, so there it is whenever another app has the focus.
 */
const inBackground = () =>
  desktop.isDesktop ? !document.hasFocus() : document.visibilityState !== "visible";

/**
 * Remembers which notifications this tab has seen, and shows the new unread ones. The first list
 * only sets the baseline, so opening Omni never replays old ones. Shows nothing while Omni is in
 * front: the app itself is on screen then. In the desktop app, `Notification` is the
 * notification plugin's (Tauri installs it), so the same call shows a native one.
 */
export function createNotifier(open: (notice: Notice) => void) {
  let seen: Set<string> | null = null;
  return (notices: readonly Notice[]) => {
    const fresh = seen ? notices.filter((n) => !n.readAt && !seen!.has(n.id)) : [];
    seen = new Set([...(seen ?? []), ...notices.map((n) => n.id)]);
    if (currentState() !== "on" || !inBackground()) return;
    for (const notice of fresh) {
      const shown = new Notification(notificationTitle(notice), {
        body: notificationSubject(notice) ?? "",
        // One per notification, even if two tabs both show it.
        tag: notice.id,
      });
      shown.onclick = () => {
        window.focus();
        open(notice);
        shown.close();
      };
    }
  };
}
