// Undo from a toast: an action that can be reversed offers its inverse here ("Resolved · Undo").
// One offer at a time, the latest; it lapses after `ms`. No React here: `hooks/use-undo.ts`
// subscribes, and the `z` shortcut runs it.

export interface UndoOffer {
  /** Changes with every offer, so a toast can key on it and restart its timer. */
  id: number;
  /** What was done, for the toast and the screen reader: "Resolved", "3 threads assigned to you". */
  label: string;
  /** When the offer lapses (ms since epoch). */
  expiresAt: number;
}

/** How long an offer stands by default: long enough to read the toast and reach for `z`. */
export const UNDO_MS = 8000;

let current: (UndoOffer & { run: () => void }) | null = null;
let lapse: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: typeof current) {
  clearTimeout(lapse);
  current = next;
  if (next)
    lapse = setTimeout(() => current?.id === next.id && set(null), next.expiresAt - Date.now());
  for (const listener of listeners) listener();
}

/**
 * Offers `undo` as the inverse of what just happened, replacing any earlier offer. Call it from a
 * mutation's caller after `mutate`, with the inverse built from the state before the change
 * (the previous assignee, the status it had).
 */
export function offerUndo(label: string, undo: () => void, ms = UNDO_MS) {
  set({ id: nextId++, label, expiresAt: Date.now() + ms, run: undo });
}

/** Runs the standing offer, once. False when there is none (it lapsed or was used). */
export function runUndo() {
  const offer = current;
  if (!offer) return false;
  set(null);
  offer.run();
  return true;
}

export function dismissUndo() {
  set(null);
}

/** For `useSyncExternalStore`: the standing offer, or null. */
export const undoStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => {
    const result: UndoOffer | null = current;
    return result;
  },
};
