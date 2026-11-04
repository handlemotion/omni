import type { ThreadSummary, ThreadView } from "./types.ts";

/**
 * The lists a member's triage action takes a thread out of (ADR 0007). The optimistic cache and
 * the list's keyboard cursor both read this, so the row the cursor skips is the row that goes.
 */
const LEAVES = {
  done: ["inbox", "queue"],
  undone: ["done"],
  defer: ["inbox", "done"],
  undefer: ["queue"],
  archive: ["inbox", "queue"],
} as const satisfies Record<string, readonly ThreadView[]>;

export function leavesView(action: keyof typeof LEAVES, view: ThreadView | undefined) {
  return (LEAVES[action] as readonly (ThreadView | undefined)[]).includes(view);
}

/** How long a quick defer lasts, until there's a picker. */
export const DEFER_MS = 24 * 60 * 60 * 1000;

/** A deferral whose time has passed is over: the thread is back in the inbox. */
export function isDeferred(until: string | null) {
  return until !== null && new Date(until).getTime() > Date.now();
}

/** One sender: their name. Several: first names, in the order they wrote. */
export function senderLabel(thread: Pick<ThreadSummary, "participants" | "latestFrom">) {
  const people = thread.participants.length
    ? thread.participants
    : thread.latestFrom
      ? [thread.latestFrom]
      : [];
  if (people.length === 1) return people[0]?.name || people[0]?.address || "";
  return people.map((p) => p.name?.split(" ")[0] || p.address.split("@")[0]).join(", ");
}
