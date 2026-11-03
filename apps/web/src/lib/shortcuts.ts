// Keyboard shortcuts: the one definition. The key handler, the `?` list, the command menu and
// `aria-keyshortcuts` all read this table, so what the app does and what it says can't drift.
// No React here; `hooks/use-shortcuts.ts` dispatches keys and runs handlers.

/**
 * A key as `KeyboardEvent.key` reports it (`j`, `Enter`, `ArrowDown`, `?`), or `Mod+k`: ⌘ on a
 * Mac, Ctrl elsewhere. A sequence (`["g", "i"]`) is pressed one key after the other.
 */
export type KeySequence = readonly string[];

export interface ShortcutDefinition {
  label: string;
  group: "Threads" | "Go to" | "General";
  /** Alternatives; the first is the one shown. */
  keys: readonly KeySequence[];
  /** Also offered in the ⌘K menu (moving the cursor makes no sense there). */
  command?: boolean;
}

export const SHORTCUTS = {
  next: { label: "Next thread", group: "Threads", keys: [["j"], ["ArrowDown"]] },
  previous: { label: "Previous thread", group: "Threads", keys: [["k"], ["ArrowUp"]] },
  open: { label: "Open thread", group: "Threads", keys: [["o"], ["Enter"]] },
  select: { label: "Select thread", group: "Threads", keys: [["x"]] },
  done: { label: "Mark done", group: "Threads", keys: [["e"]], command: true },
  defer: { label: "Defer to Queue", group: "Threads", keys: [["h"]], command: true },
  read: { label: "Mark read or unread", group: "Threads", keys: [["u"]], command: true },
  close: { label: "Close thread", group: "Threads", keys: [["Escape"]], command: true },
  goInbox: { label: "Inbox", group: "Go to", keys: [["g", "i"]], command: true },
  goQueue: { label: "Queue", group: "Go to", keys: [["g", "q"]], command: true },
  goAll: { label: "All mail", group: "Go to", keys: [["g", "a"]], command: true },
  compose: { label: "Compose", group: "General", keys: [["c"]], command: true },
  search: { label: "Search", group: "General", keys: [["/"]] },
  commandMenu: { label: "Command menu", group: "General", keys: [["Mod+k"]] },
  help: { label: "Keyboard shortcuts", group: "General", keys: [["?"]], command: true },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const SHORTCUT_IDS = Object.keys(SHORTCUTS) as ShortcutId[];

/** The key this event names in `SHORTCUTS`' terms, or null for a chord we never bind. */
export function eventKey(event: KeyboardEvent): string | null {
  if (event.altKey) return null;
  if (event.metaKey || event.ctrlKey) {
    return event.key.length === 1 ? `Mod+${event.key.toLowerCase()}` : null;
  }
  return event.key;
}

/** How long the second key of a sequence (`g` then `i`) may take. */
const SEQUENCE_MS = 1000;

/**
 * Feeds keys in, gets shortcut ids out. `pending` means the key starts a sequence: swallow it
 * and wait for the next one.
 */
export function createMatcher() {
  let prefix: string[] = [];
  let at = 0;
  return (key: string, now = Date.now()): ShortcutId | "pending" | null => {
    const held = now - at <= SEQUENCE_MS ? prefix : [];
    // A key that ends no sequence may still start one ("g" after a stray "g").
    const found = (held.length ? find([...held, key]) : null) ?? find([key]);
    prefix = found?.pending ?? [];
    at = now;
    return found ? (found.id ?? "pending") : null;
  };
}

function find(typed: string[]): { id?: ShortcutId; pending?: string[] } | null {
  let pending = false;
  for (const id of SHORTCUT_IDS) {
    for (const sequence of SHORTCUTS[id].keys) {
      if (sequence.length < typed.length || !typed.every((k, i) => sequence[i] === k)) continue;
      if (sequence.length === typed.length) return { id };
      pending = true;
    }
  }
  return pending ? { pending: typed } : null;
}

const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

const NAMES: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  Escape: "Esc",
  Enter: "Enter",
};

/** One key as people read it: `Mod+k` is `⌘K` on a Mac and `Ctrl K` elsewhere. */
export function keyLabel(key: string): string[] {
  if (key.startsWith("Mod+")) {
    const letter = key.slice(4).toUpperCase();
    return isMac() ? ["⌘", letter] : ["Ctrl", letter];
  }
  return [NAMES[key] ?? key.toUpperCase()];
}

/** The `aria-keyshortcuts` value: every alternative, space-separated (sequences can't be said). */
export function ariaKeyShortcuts(id: ShortcutId): string {
  return SHORTCUTS[id].keys
    .filter((sequence) => sequence.length === 1)
    .map(([key = ""]) =>
      key.startsWith("Mod+")
        ? `${isMac() ? "Meta" : "Control"}+${key.slice(4).toUpperCase()}`
        : key,
    )
    .join(" ");
}
