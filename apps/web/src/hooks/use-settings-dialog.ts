// Settings is a dialog over the workspace, not a page: ⌘., the sidebar's Settings button and the
// `/settings` path all open it here, on the page they ask for. One store, so each opener needs no
// prop drilling and the dialog remembers the last page between openings.
import { useSyncExternalStore } from "react";

export const SETTINGS_PAGES = [
  "profile",
  "security",
  "shortcuts",
  "general",
  "people",
  "mailboxes",
  "shared-mailboxes",
  "members-inboxes",
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

interface SettingsDialogState {
  isOpen: boolean;
  page: SettingsPageId;
}

let state: SettingsDialogState = { isOpen: false, page: "profile" };
const listeners = new Set<() => void>();

function set(next: Partial<SettingsDialogState>) {
  state = { ...state, ...next };
  for (const notify of listeners) notify();
}

/** Opens settings on `page`, or on the page it showed last. */
export function openSettings(page?: SettingsPageId) {
  set({ isOpen: true, ...(page && { page }) });
}

export function closeSettings() {
  set({ isOpen: false });
}

export function toggleSettings() {
  set({ isOpen: !state.isOpen });
}

export function showSettingsPage(page: SettingsPageId) {
  set({ page });
}

export function useSettingsDialog(): SettingsDialogState {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => state,
  );
}
