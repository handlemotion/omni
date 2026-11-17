import type { ThreadSummary, ThreadView } from "./types.ts";

const LEAVES = {
  done: ["inbox", "later"],
  undone: ["done"],
  later: ["inbox", "done"],
  unlater: ["later"],
  archive: ["inbox", "later"],
  trash: ["inbox", "later", "sent", "spam"],
} as const satisfies Record<string, readonly ThreadView[]>;

export function leavesView(action: keyof typeof LEAVES, view: ThreadView | undefined) {
  return (LEAVES[action] as readonly (ThreadView | undefined)[]).includes(view);
}

/** The address behind the label's first name, whose picture stands for the thread. */
export function senderAddress(thread: Pick<ThreadSummary, "participants" | "latestFrom">) {
  return (thread.participants[0] ?? thread.latestFrom)?.address;
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
