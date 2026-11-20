import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";

/**
 * A page of `/api/notifications`: newest first, with your total `unread` count. The wording below
 * is the web's (`apps/web/src/lib/notification-text.ts`); change both together.
 */
export type NotificationPage = InferResponseType<Api["notifications"]["$get"], 200>;
export type Notification = NotificationPage["notifications"][number];

/** Who did it, by name, else by address; undefined when nobody did (a customer, a clock). */
export function actorName(n: Pick<Notification, "actor">) {
  return n.actor ? n.actor.name || n.actor.email || undefined : undefined;
}

const DONE_BY: Partial<Record<Notification["kind"], string>> = {
  assigned: "assigned you",
  mention: "mentioned you",
  note: "left a note",
  member_joined: "joined the workspace",
  comment: "commented",
};

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

/** Where a comment notification leads: the file. */
export interface CommentTarget {
  nodeId: string;
  nodeName: string;
  excerpt: string;
}

/** A comment notification's file, or undefined for any other kind (or a malformed one). */
export const commentTarget: (
  n: Pick<Notification, "kind" | "data">,
) => CommentTarget | undefined = (n) => {
  if (n.kind !== "comment") return undefined;
  const d = n.data as Partial<CommentTarget>;
  if (typeof d.nodeId !== "string") return undefined;
  return {
    nodeId: d.nodeId,
    nodeName: typeof d.nodeName === "string" ? d.nodeName : "",
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
