import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DesktopSyncStatus, DesktopWorkspaceSync } from "@omni/client";
import { onAction, sendNotification } from "@tauri-apps/plugin-notification";

export const openOutside = (url: string) => openUrl(url);

export const setBadge = (count: number) =>
  getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);

const OVERLAY_PX = 32;

/**
 * Windows has no count badge: the count is drawn on the taskbar button's overlay icon instead, a
 * red disc with the number (`9+` past nine), as Windows' own apps do.
 */
export async function setOverlayBadge(count: number) {
  const window = getCurrentWindow();
  if (count <= 0) return window.setOverlayIcon(undefined);
  const canvas = new OffscreenCanvas(OVERLAY_PX, OVERLAY_PX);
  const context = canvas.getContext("2d");
  if (!context) return;
  const middle = OVERLAY_PX / 2;
  context.fillStyle = "#c42b1c";
  context.beginPath();
  context.arc(middle, middle, middle, 0, Math.PI * 2);
  context.fill();
  const label = count > 9 ? "9+" : String(count);
  context.fillStyle = "#ffffff";
  context.font = `600 ${label.length > 1 ? 17 : 21}px "Segoe UI", system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, middle, middle + 1);
  const { data } = context.getImageData(0, 0, OVERLAY_PX, OVERLAY_PX);
  const icon = await Image.new(new Uint8Array(data.buffer), OVERLAY_PX, OVERLAY_PX);
  try {
    await window.setOverlayIcon(icon);
  } finally {
    await icon.close();
  }
}

/** `omni://auth?state=…`, issued once by the shell for this sign-in (`deep_link.rs`). */
export const signInCallback = () => invoke<string>("sign_in_callback");

/** Drive sync on this computer (`apps/desktop/src-tauri/src/sync`). */
export const syncStatus = () => invoke<DesktopSyncStatus>("sync_status");
export const syncConnect = (orgId: string) =>
  invoke<DesktopWorkspaceSync>("sync_connect", { orgId });
export const syncDisconnect = (orgId: string) =>
  invoke<DesktopWorkspaceSync>("sync_disconnect", { orgId });

/** A shell update downloaded and waiting to install, by version (`updater.rs`). */
export const updateReady = () => invoke<string | null>("update_ready");
export const updateInstall = () => invoke<void>("update_install");
export const onUpdateReady = (handler: (version: string) => void) =>
  listen<string>("update-ready", (event) => handler(event.payload));

export const startDragging = () => getCurrentWindow().startDragging();

export const toggleMaximize = () => getCurrentWindow().toggleMaximize();

/** Brings the window back: shown (closing it only hides it), not minimized, in front. */
export async function focusWindow() {
  const window = getCurrentWindow();
  await window.show();
  await window.unminimize();
  await window.setFocus();
}

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
