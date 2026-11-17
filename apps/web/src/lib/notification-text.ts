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
  comment: "commented",
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
  comment: "New comment",
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

/** Where a comment notification leads: the file and the folder holding it (ADR 0043). */
export interface CommentTarget {
  nodeId: string;
  nodeName: string;
  space: "personal" | "shared";
  folderId: string | null;
  excerpt: string;
}

/** A comment notification's file, or undefined for any other kind (or a malformed one). */
export const commentTarget: (
  n: Pick<Notification, "kind" | "data">,
) => CommentTarget | undefined = (n) => {
  if (n.kind !== "comment") return undefined;
  const d = n.data as Partial<CommentTarget>;
  if (typeof d.nodeId !== "string" || (d.space !== "personal" && d.space !== "shared")) return;
  return {
    nodeId: d.nodeId,
    nodeName: typeof d.nodeName === "string" ? d.nodeName : "",
    space: d.space,
    folderId: typeof d.folderId === "string" ? d.folderId : null,
    excerpt: typeof d.excerpt === "string" ? d.excerpt : "",
  };
};

/**
 * What it is about: the conversation's subject; for a comment, the file and its first words;
 * nothing for a workspace notification.
 */
export function notificationSubject(
  n: Pick<Notification, "threadId" | "subject" | "kind" | "data">,
) {
  const comment = commentTarget(n);
  if (comment)
    return comment.excerpt ? `${comment.nodeName}: ${comment.excerpt}` : comment.nodeName;
  if (!n.threadId) return undefined;
  return n.subject || "(no subject)";
}
