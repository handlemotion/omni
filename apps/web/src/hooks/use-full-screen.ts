import { useCallback, useSyncExternalStore } from "react";

const KEY = "omni:full-screen";
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

/** `[fullScreen, toggle]`. Side by side unless the person chose full screen. */
export function useFullScreen() {
  const fullScreen = useSyncExternalStore(subscribe, () => current);
  const toggle = useCallback(() => {
    current = !current;
    try {
      localStorage.setItem(KEY, current ? "1" : "0");
    } catch {}
    for (const listener of listeners) listener();
  }, []);
  return [fullScreen, toggle] as const;
}
