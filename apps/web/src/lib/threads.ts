import type { ThreadSummary, ThreadView } from "./types.ts";

/**
 * The lists a member's triage action takes a thread out of (ADR 0007). The optimistic cache and
 * the list's keyboard cursor both read this, so the row the cursor skips is the row that goes.
 */
const LEAVES = {
  done: ["inbox", "later"],
  undone: ["done"],
  later: ["inbox", "done"],
  unlater: ["later"],
  archive: ["inbox", "later"],
  // Every copy moves to Trash, the sent and junk ones too.
  trash: ["inbox", "later", "sent", "spam"],
} as const satisfies Record<string, readonly ThreadView[]>;

export function leavesView(action: keyof typeof LEAVES, view: ThreadView | undefined) {
  return (LEAVES[action] as readonly (ThreadView | undefined)[]).includes(view);
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
