import { useCallback, useSyncExternalStore } from "react";

export type StorageView = "rows" | "cards";

const DEFAULT: StorageView = "cards";
const KEY = "omni:storage-view";
const listeners = new Set<() => void>();

const read: () => StorageView = () => {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "rows" || stored === "cards" ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
};

let current = read();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `[view, setView]` for Drive's folders. */
export function useStorageView() {
  const view = useSyncExternalStore(subscribe, () => current);
  const setView = useCallback((next: StorageView) => {
    current = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    for (const listener of listeners) listener();
  }, []);
  return [view, setView] as const;
}
