import { useCallback, useSyncExternalStore } from "react";

const KEY = "omni:file-details";
const listeners = new Set<() => void>();

function read() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let current = read();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `[shown, toggle]` for an open file's details bar: hidden unless the person showed it. */
export function useShowDetails() {
  const shown = useSyncExternalStore(subscribe, () => current);
  const toggle = useCallback(() => {
    current = !current;
    try {
      localStorage.setItem(KEY, current ? "1" : "0");
    } catch {}
    for (const listener of listeners) listener();
  }, []);
  return [shown, toggle] as const;
}
