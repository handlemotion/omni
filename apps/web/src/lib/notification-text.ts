// What a notification says, in the panel and as a desktop notification: who did it, what they
// did, and what it is about (the conversation's subject; nothing for a workspace notification).
import type { Notification } from "./types.ts";

/** Who did it, by name, else by address; undefined when nobody did (a customer, a clock). */
export function actorName(n: Pick<Notification, "actor">) {
  return n.actor ? n.actor.name || n.actor.email || undefined : undefined;
}

/** What happened, said after the actor's name: "assigned you". */
const DONE_BY: Partial<Record<Notification["kind"], string>> = {
  assigned: "assigned you",
  mention: "mentioned you",
  note: "left a note",
  member_joined: "joined the workspace",
};

/** What happened when nobody did it, or we no longer know who. */
const HAPPENED: Record<Notification["kind"], string> = {
  assigned: "Assigned to you",
  mention: "You were mentioned",
  note: "New note",
  customer_reply: "The customer replied",
  sla_at_risk: "Due soon",
  sla_breached: "Overdue",
  member_joined: "Someone joined the workspace",
};

/** The line's parts: the actor (when someone did it) and what happened. */
export function notificationParts(n: Pick<Notification, "kind" | "actor">) {
  const actor = actorName(n);
  const action = DONE_BY[n.kind];
  return actor && action ? { actor, action } : { actor: undefined, action: HAPPENED[n.kind] };
}

/** The whole line: "Bea Klein assigned you". */
export function notificationTitle(n: Pick<Notification, "kind" | "actor">) {
  const { actor, action } = notificationParts(n);
  return actor ? `${actor} ${action}` : action;
}

/** What it is about: the conversation's subject, or nothing for a workspace notification. */
export function notificationSubject(n: Pick<Notification, "threadId" | "subject">) {
  if (!n.threadId) return undefined;
  return n.subject || "(no subject)";
}
