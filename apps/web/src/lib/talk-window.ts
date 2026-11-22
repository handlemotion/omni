import { useSyncExternalStore } from "react";

/** The key the window opens as the people chooser, from `+n`. */
export const EVERYONE = "everyone";

const PEEK_MS = 200;
const LEAVE_MS = 300;

let state: { memberId: string | null; pinned: boolean } = { memberId: null, pinned: false };
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const set = (memberId: string | null, pinned: boolean) => {
  clearTimeout(timer);
  if (state.memberId === memberId && state.pinned === pinned) return;
  state = { memberId, pinned };
  for (const listener of listeners) listener();
};
const later = (ms: number, fn: () => void) => {
  clearTimeout(timer);
  timer = setTimeout(fn, ms);
};

/**
 * The one conversation window. It behaves like a tooltip over the stack: resting on a face a
 * beat peeks at that person's thread, moving to another face moves it there at once, and leaving
 * both closes it; a press, or a touch inside it, pins it open.
 */
export const talkWindow = {
  get: () => state.memberId,
  state: () => state,
  open: (memberId: string) => set(memberId, true),
  close: () => set(null, false),
  pin: () => state.memberId && set(state.memberId, true),
  hover(memberId: string) {
    if (state.memberId === memberId) return clearTimeout(timer);
    if (state.memberId) return set(memberId, state.pinned);
    later(PEEK_MS, () => set(memberId, false));
  },
  stay: () => clearTimeout(timer),
  leave() {
    if (!state.memberId) return clearTimeout(timer);
    if (!state.pinned) later(LEAVE_MS, () => set(null, false));
  },
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The member whose conversation is open, or null. */
export const useTalkWindow = () => useSyncExternalStore(subscribe, talkWindow.get);

/** Whether the open conversation is pinned rather than a hover peek. */
export const useTalkPinned = () => useSyncExternalStore(subscribe, () => talkWindow.state().pinned);
