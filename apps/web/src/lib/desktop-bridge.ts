// Tauri's JS API, loaded only inside the desktop app (`desktop.ts` imports this dynamically).
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

export const openOutside = (url: string) => openUrl(url);

// `undefined` removes the badge.
export const setBadge = (count: number) =>
  getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);

/** `omni://auth?state=…`, issued once by the shell for this sign-in (`deep_link.rs`). */
export const signInCallback = () => invoke<string>("sign_in_callback");

export const startDragging = () => getCurrentWindow().startDragging();

export const toggleMaximize = () => getCurrentWindow().toggleMaximize();
