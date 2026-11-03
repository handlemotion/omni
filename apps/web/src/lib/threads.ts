import type { ThreadSummary } from "./types.ts";

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
