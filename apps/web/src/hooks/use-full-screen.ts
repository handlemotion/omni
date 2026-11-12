// Whether an open conversation takes the whole width (the list hides) or sits beside the list.
// One value for the whole app, remembered in this browser: the list hides by it and the
// conversation's toolbar toggles it, so both read the same store.
import { useCallback, useSyncExternalStore } from "react";

const KEY = "omni:full-screen";
const listeners = new Set<() => void>();

function read() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false; // Storage unavailable (private mode): side by side.
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
    } catch {
      // The choice lasts for this page only.
    }
    for (const listener of listeners) listener();
  }, []);
  return [fullScreen, toggle] as const;
}
