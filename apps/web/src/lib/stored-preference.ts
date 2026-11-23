import { useSyncExternalStore } from "react";

function storedValue<T>(
  key: string,
  parse: (stored: string | null) => T,
  serialize: (value: T) => string,
) {
  const listeners = new Set<() => void>();
  let current = (() => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  })();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const get = () => current;
  const set = (next: T) => {
    current = next;
    try {
      localStorage.setItem(key, serialize(next));
    } catch {}
    for (const listener of listeners) listener();
  };
  return { get, set, subscribe };
}

/** A hook for `[on, toggle]`, off until the person turns it on. */
export function storedToggle(key: string) {
  const store = storedValue(
    key,
    (stored) => stored === "1",
    (on) => (on ? "1" : "0"),
  );
  const toggle = () => store.set(!store.get());
  return function useStoredToggle() {
    return [useSyncExternalStore(store.subscribe, store.get), toggle] as const;
  };
}

/** A hook for `[value, setValue]`, one of `values`; `fallback` until the person picks. */
export function storedChoice<T extends string>(key: string, values: readonly T[], fallback: T) {
  const store = storedValue(
    key,
    (stored) => values.find((value) => value === stored) ?? fallback,
    (value) => value,
  );
  return function useStoredChoice() {
    return [useSyncExternalStore(store.subscribe, store.get), store.set] as const;
  };
}
