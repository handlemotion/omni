// Tauri's JS API, loaded only inside the desktop app (`desktop.ts` imports this dynamically).
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onAction, sendNotification } from "@tauri-apps/plugin-notification";

export const openOutside = (url: string) => openUrl(url);

// `undefined` removes the badge.
export const setBadge = (count: number) =>
  getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);

/** `omni://auth?state=…`, issued once by the shell for this sign-in (`deep_link.rs`). */
export const signInCallback = () => invoke<string>("sign_in_callback");

export const startDragging = () => getCurrentWindow().startDragging();

export const toggleMaximize = () => getCurrentWindow().toggleMaximize();

/** Brings the window back: shown (closing it only hides it), not minimized, in front. */
export async function focusWindow() {
  const window = getCurrentWindow();
  await window.show();
  await window.unminimize();
  await window.setFocus();
}

/** What a click on each notification shown this run does, by its id; the oldest drop first. */
const clicks = new Map<number, () => void>();
const MAX_CLICKS = 200;
let nextId = 1;
let listening: Promise<unknown> | undefined;

/**
 * A native notification. The plugin reports a click only while a listener is registered, so one
 * is in place before the first notification; a click on a notification older than the last
 * `MAX_CLICKS` still brings the app forward (macOS does), just not to the item.
 */
export async function notify(title: string, body: string, onClick: () => void) {
  listening ??= onAction((event) => {
    const id = event.notification?.id;
    const open = id === undefined ? undefined : clicks.get(id);
    if (!open || id === undefined) return;
    clicks.delete(id);
    open();
  }).catch((error: unknown) => console.warn("desktop: notification clicks unavailable", error));
  await listening;
  const id = nextId++;
  clicks.set(id, onClick);
  const oldest = clicks.keys().next().value;
  if (clicks.size > MAX_CLICKS && oldest !== undefined) clicks.delete(oldest);
  sendNotification({ id, title, body });
}
