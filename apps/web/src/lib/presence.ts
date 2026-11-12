// Who else is looking at or replying in a conversation ("Bea is replying"). Realtime `presence`
// events fill it; nothing is fetched. Each entry expires unless the teammate's app repeats it, so
// a closed laptop that never said `left` stops showing within `TTL_MS`.
import type { RealtimeEvent } from "./types.ts";

type PresenceEvent = Extract<RealtimeEvent, { type: "presence" }>;

export interface Presence {
  memberId: string;
  /** The workspace whose socket reported it, so a drop there clears only its entries. */
  orgId: string;
  state: "viewing" | "replying";
  /** When the last event for this member arrived (ms since epoch). */
  at: number;
}

/** How long an entry lives without a fresh event. The reporter repeats every `REPEAT_MS`. */
export const TTL_MS = 70_000;
export const REPEAT_MS = 30_000;

const EMPTY: readonly Presence[] = [];
// threadId → memberId → presence. Snapshots are replaced, never mutated, for useSyncExternalStore.
let byThread = new Map<string, readonly Presence[]>();
const listeners = new Set<() => void>();
let sweep: ReturnType<typeof setTimeout> | undefined;

function emit() {
  for (const listener of listeners) listener();
  scheduleSweep();
}

function scheduleSweep() {
  clearTimeout(sweep);
  const oldest = Math.min(...[...byThread.values()].flat().map((p) => p.at));
  if (!Number.isFinite(oldest)) return;
  sweep = setTimeout(expire, Math.max(0, oldest + TTL_MS - Date.now()) + 50);
}

function expire() {
  const now = Date.now();
  let changed = false;
  const next = new Map<string, readonly Presence[]>();
  for (const [threadId, list] of byThread) {
    const live = list.filter((p) => now - p.at < TTL_MS);
    if (live.length !== list.length) changed = true;
    if (live.length) next.set(threadId, live);
  }
  if (!changed) return scheduleSweep();
  byThread = next;
  emit();
}

export function applyPresence(orgId: string, event: PresenceEvent) {
  const others = (byThread.get(event.threadId) ?? EMPTY).filter(
    (p) => p.memberId !== event.memberId,
  );
  const list =
    event.state === "left"
      ? others
      : [...others, { memberId: event.memberId, orgId, state: event.state, at: Date.now() }];
  byThread = new Map(byThread);
  if (list.length) byThread.set(event.threadId, list);
  else byThread.delete(event.threadId);
  emit();
}

/**
 * Forgets everyone a workspace's socket reported (every workspace without `orgId`): it dropped, so
 * `left` events may have been missed. Teammates still there reappear with their next repeat.
 */
export function clearPresence(orgId?: string) {
  const next = new Map<string, readonly Presence[]>();
  for (const [threadId, list] of byThread) {
    const kept = orgId ? list.filter((p) => p.orgId !== orgId) : [];
    if (kept.length) next.set(threadId, kept);
  }
  if ([...next.values()].flat().length === [...byThread.values()].flat().length) return;
  byThread = next;
  emit();
}

/** For `useSyncExternalStore`. */
export const presenceStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (threadId: string) => byThread.get(threadId) ?? EMPTY,
};
