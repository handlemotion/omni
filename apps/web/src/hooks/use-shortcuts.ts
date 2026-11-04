// Runs keyboard shortcuts. `lib/shortcuts.ts` says which keys mean what; components say what
// each one does where they are (`useShortcut`). The shell mounts one key listener
// (`useShortcutListener`); the ⌘K menu runs the same handlers (`runShortcut`).
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createMatcher, eventKey, type ShortcutId } from "../lib/shortcuts.ts";

// The most recently mounted handler for an id wins, so a nested screen can take over a key.
const handlers = new Map<ShortcutId, (() => void)[]>();
const subscribers = new Set<() => void>();
let available: ReadonlySet<ShortcutId> = new Set();

function changed() {
  available = new Set([...handlers].filter(([, list]) => list.length).map(([id]) => id));
  for (const notify of subscribers) notify();
}

/** Binds `run` to shortcut `id` while the component is mounted and `enabled`. */
export function useShortcut(id: ShortcutId, run: () => void, enabled = true) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (!enabled) return;
    const handler = () => latest.current();
    handlers.set(id, [...(handlers.get(id) ?? []), handler]);
    changed();
    return () => {
      handlers.set(
        id,
        (handlers.get(id) ?? []).filter((h) => h !== handler),
      );
      changed();
    };
  }, [id, enabled]);
}

/** Runs the shortcut's current handler. False when nothing on screen handles it. */
export function runShortcut(id: ShortcutId): boolean {
  const handler = handlers.get(id)?.at(-1);
  handler?.();
  return !!handler;
}

/** The shortcuts something on screen handles right now (the ⌘K menu offers only these). */
export function useAvailableShortcuts(): ReadonlySet<ShortcutId> {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => available,
  );
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
// Inside these, keys belong to the widget (a menu's typeahead, a dialog's own Escape).
const OWN_KEYS = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=combobox]";
// Keys that already do something on a focused control: only take them when nothing is focused.
const NATIVE = new Set(["Enter", "ArrowDown", "ArrowUp"]);

/**
 * The one document key listener. Plain keys never fire while typing in a field or inside a
 * dialog or menu (⌘ chords do), and it leaves alone any key a focused widget already handled (`defaultPrevented`): React
 * Aria's list moves with the arrows itself and opens a row on Enter.
 */
export function useShortcutListener() {
  useEffect(() => {
    const match = createMatcher();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const key = eventKey(event);
      if (!key) return;
      const target = event.target instanceof Element ? event.target : null;
      const focused = target && target !== document.body && target !== document.documentElement;
      // A ⌘ chord can't be typing and no widget uses one, so it works from anywhere.
      const chord = key.startsWith("Mod+");
      if (!chord && (target?.closest(EDITABLE) || target?.closest(OWN_KEYS))) return;
      if (focused && NATIVE.has(key)) return;
      const id = match(key);
      if (id === "pending") event.preventDefault();
      else if (id && runShortcut(id)) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

// A polite live region for what a shortcut did ("Marked done") when nothing else on screen
// would tell a screen reader. The shell renders it (`useAnnouncement`).
let message = "";
const listeners = new Set<() => void>();

export function announce(text: string) {
  // Clear first so the same message twice in a row is read twice.
  message = "";
  for (const notify of listeners) notify();
  queueMicrotask(() => {
    message = text;
    for (const notify of listeners) notify();
  });
}

export function useAnnouncement(): string {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => message,
  );
}
