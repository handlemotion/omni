// Keyboard shortcuts: the one definition. The key handler, the `?` list, the command menu and
// `aria-keyshortcuts` all read this table, so what the app does and what it says can't drift.
// No React here; `hooks/use-shortcuts.ts` dispatches keys and runs handlers.
import { desktop } from "./desktop.ts";

/**
 * A key as `KeyboardEvent.key` reports it (`j`, `Enter`, `ArrowDown`, `?`), or `Mod+k`: ⌘ on a
 * Mac, Ctrl elsewhere. A sequence (`["g", "i"]`) is pressed one key after the other.
 */
export type KeySequence = readonly string[];

/**
 * Keys only the desktop app binds (docs/spec/desktop.md, "Navigation changes in the web app"): a
 * browser keeps ⌘N, ⌘R and ⌘[ for itself, and has its own back and forward.
 */
const inDesktop = (...keys: KeySequence[]) =>
  (desktop.isDesktop ? keys : []) satisfies KeySequence[];
const onWindows = desktop.platform === "windows";

/**
 * Where a shortcut works: inside one module (`mail`, `files`, `crm`) or on the settings pages. A
 * shortcut with no place works everywhere (go-to, ⌘K, `?`). See `useShortcut`.
 */
export type ShortcutPlace = "mail" | "files" | "crm" | "settings";

export interface ShortcutDefinition {
  label: string;
  group: "Threads" | "Go to" | "General";
  /** The one place this key works; anywhere when left out. */
  place?: ShortcutPlace;
  /** Alternatives; the first is the one shown. */
  keys: readonly KeySequence[];
  /** A command row in the ⌘K command menu (moving the cursor makes no sense there). */
  command?: boolean;
}

export const SHORTCUTS = {
  next: { label: "Next thread", group: "Threads", place: "mail", keys: [["j"], ["ArrowDown"]] },
  previous: {
    label: "Previous thread",
    group: "Threads",
    place: "mail",
    keys: [["k"], ["ArrowUp"]],
  },
  open: { label: "Open thread", group: "Threads", place: "mail", keys: [["o"], ["Enter"]] },
  select: { label: "Select thread", group: "Threads", place: "mail", keys: [["x"]] },
  done: { label: "Mark done", group: "Threads", place: "mail", keys: [["e"]], command: true },
  later: { label: "Move to Later", group: "Threads", place: "mail", keys: [["h"]], command: true },
  read: {
    label: "Mark read or unread",
    group: "Threads",
    place: "mail",
    keys: [["u"]],
    command: true,
  },
  close: {
    label: "Close thread",
    group: "Threads",
    place: "mail",
    keys: [["Escape"]],
    command: true,
  },
  // Helpdesk conversations (shared inboxes). Resolve and snooze take the keys of done and later,
  // which they replace there: a screen binds one or the other, and the key runs whichever is bound.
  reply: { label: "Reply", group: "Threads", place: "mail", keys: [["r"]], command: true },
  note: {
    label: "Add internal note",
    group: "Threads",
    place: "mail",
    keys: [["n"]],
    command: true,
  },
  assignToMe: {
    label: "Assign to me",
    group: "Threads",
    place: "mail",
    keys: [["i"]],
    command: true,
  },
  resolve: {
    label: "Resolve or reopen",
    group: "Threads",
    place: "mail",
    keys: [["e"]],
    command: true,
  },
  snooze: { label: "Snooze", group: "Threads", place: "mail", keys: [["h"]], command: true },
  // A chord, so it works while typing in the composer, where the picker is used.
  cannedReply: {
    label: "Insert canned reply",
    group: "Threads",
    place: "mail",
    keys: [["Mod+/"]],
    command: true,
  },
  undo: { label: "Undo", group: "General", keys: [["z"]], command: true },
  goInbox: { label: "Inbox", group: "Go to", keys: [["g", "i"]], command: true },
  goLater: { label: "Later", group: "Go to", keys: [["g", "l"]], command: true },
  goAll: { label: "All mail", group: "Go to", keys: [["g", "a"]], command: true },
  goDrive: { label: "Drive", group: "Go to", keys: [["g", "f"]], command: true },
  compose: {
    label: "Compose",
    group: "General",
    place: "mail",
    keys: [["c"], ...inDesktop(["Mod+n"])],
    command: true,
  },
  // Bound by the command menu (`components/search/command-menu.tsx`).
  search: { label: "Search", group: "General", keys: [["/"]] },
  commandMenu: { label: "Search and commands", group: "General", keys: [["Mod+k"]] },
  help: { label: "Keyboard shortcuts", group: "General", keys: [["?"]], command: true },
  // Opens and closes from anywhere, even while typing or inside another dialog (see the listener).
  settings: { label: "Settings", group: "General", keys: [...inDesktop(["Mod+,"]), ["Mod+."]] },
  back: {
    label: "Back",
    group: "General",
    keys: inDesktop(onWindows ? ["Alt+ArrowLeft"] : ["Mod+["]),
  },
  forward: {
    label: "Forward",
    group: "General",
    keys: inDesktop(onWindows ? ["Alt+ArrowRight"] : ["Mod+]"]),
  },
  reload: { label: "Reload", group: "General", keys: inDesktop(["Mod+r"]) },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUTS;

/**
 * The place a path is in. Paths are `/<workspace>/<place>/…` (ADR 0043); every shell path that is
 * not Drive's, the CRM's or settings' is Mail's, as the module switcher reads it (`moduleOf`).
 */
export function placeOf(pathname: string) {
  const place = pathname.split("/")[2];
  return (
    place === "files" || place === "crm" || place === "settings" ? place : "mail"
  ) satisfies ShortcutPlace;
}

/** The place shortcut `id` is bound to, or undefined when it works everywhere. */
export const shortcutPlace = (id: ShortcutId) =>
  (SHORTCUTS[id] as ShortcutDefinition).place satisfies ShortcutPlace | undefined;

/** Every shortcut with a key here: the desktop app's own are left out in a browser. */
export const SHORTCUT_IDS = (Object.keys(SHORTCUTS) as ShortcutId[]).filter(
  (id) => SHORTCUTS[id].keys.length > 0,
);

/**
 * The shortcuts that are also commands, in display order. The command menu renders these as
 * its command rows: offer the ones in `useAvailableShortcuts()`, run one with `runShortcut(id)`.
 */
export const COMMAND_IDS = SHORTCUT_IDS.filter((id) => "command" in SHORTCUTS[id]);

/** The key this event names in `SHORTCUTS`' terms, or null for a chord we never bind. */
export function eventKey(event: KeyboardEvent) {
  // Alt+← and Alt+→ are back and forward on Windows; no other Alt chord is bound.
  if (event.altKey) {
    const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
    return arrow && !event.metaKey && !event.ctrlKey ? `Alt+${event.key}` : null;
  }
  if (event.metaKey || event.ctrlKey) {
    return event.key.length === 1 ? `Mod+${event.key.toLowerCase()}` : null;
  }
  return event.key;
}

/** How long the second key of a sequence (`g` then `i`) may take. */
const SEQUENCE_MS = 1000;

/**
 * Feeds keys in, gets shortcut ids out: every id the keys complete, in table order (a key can
 * mean done on one screen and resolve on another; the caller runs the one that is bound).
 * `pending` means the key starts a sequence: swallow it and wait for the next one.
 */
export function createMatcher() {
  let prefix: string[] = [];
  let at = 0;
  return (key: string, now = Date.now()) => {
    const held = now - at <= SEQUENCE_MS ? prefix : [];
    // A key that ends no sequence may still start one ("g" after a stray "g").
    const found = (held.length ? find([...held, key]) : null) ?? find([key]);
    prefix = found?.pending ?? [];
    at = now;
    return (found ? (found.ids ?? "pending") : null) satisfies ShortcutId[] | "pending" | null;
  };
}

const find: (typed: string[]) => { ids?: ShortcutId[]; pending?: string[] } | null = (typed) => {
  const ids: ShortcutId[] = [];
  let pending = false;
  for (const id of SHORTCUT_IDS) {
    for (const sequence of SHORTCUTS[id].keys) {
      if (sequence.length < typed.length || !typed.every((k, i) => sequence[i] === k)) continue;
      if (sequence.length === typed.length) ids.push(id);
      else pending = true;
    }
  }
  if (ids.length) return { ids };
  return pending ? { pending: typed } : null;
};

const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

const NAMES: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "Enter",
};

/** One key as people read it: `Mod+k` is `⌘K` on a Mac and `Ctrl K` elsewhere. */
export const keyLabel: (key: string) => string[] = (key) => {
  if (key.startsWith("Mod+")) {
    const letter = key.slice(4).toUpperCase();
    return isMac() ? ["⌘", letter] : ["Ctrl", letter];
  }
  if (key.startsWith("Alt+")) return ["Alt", NAMES[key.slice(4)] ?? key.slice(4)];
  return [NAMES[key] ?? key.toUpperCase()];
};

/** The `aria-keyshortcuts` value: every alternative, space-separated (sequences can't be said). */
export function ariaKeyShortcuts(id: ShortcutId) {
  return SHORTCUTS[id].keys
    .filter((sequence) => sequence.length === 1)
    .map(([key = ""]) =>
      key.startsWith("Mod+")
        ? `${isMac() ? "Meta" : "Control"}+${key.slice(4).toUpperCase()}`
        : key,
    )
    .join(" ");
}
