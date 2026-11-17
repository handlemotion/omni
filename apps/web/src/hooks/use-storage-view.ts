import { useCallback, useSyncExternalStore } from "react";

export type StorageView = "rows" | "cards";
export type StorageSection = "folders" | "files";

const DEFAULT: Record<StorageSection, StorageView> = { folders: "cards", files: "rows" };
const KEY = (section: StorageSection) => `omni:storage-view:${section}`;
const listeners = new Set<() => void>();

const read: (section: StorageSection) => StorageView = (section) => {
  try {
    const stored = localStorage.getItem(KEY(section));
    return stored === "rows" || stored === "cards" ? stored : DEFAULT[section];
  } catch {
    return DEFAULT[section];
  }
};

const current: Record<StorageSection, StorageView> = {
  folders: read("folders"),
  files: read("files"),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `[view, setView]` for one section. */
export function useStorageView(section: StorageSection) {
  const view = useSyncExternalStore(subscribe, () => current[section]);
  const setView = useCallback(
    (next: StorageView) => {
      current[section] = next;
      try {
        localStorage.setItem(KEY(section), next);
      } catch {}
      for (const listener of listeners) listener();
    },
    [section],
  );
  return [view, setView] as const;
}
