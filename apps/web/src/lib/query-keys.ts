// Every query key in the app, in one tree, so invalidation can target a branch:
//
//   omni
//   ├─ session · device-sessions · sessions · sign-in-methods · sign-in-emails
//   ├─ org ─ organizations · members · invitations · invitation(id) · passkeys · onboarding
//   │        · workspaces · billing · billing-cards · billing-invoices
//   ├─ mail ─ mailboxes · workspace-mailboxes · mailbox-members(id) · counts · threads(filter)
//   │        · thread(id) ─ conversation · search(q) · action(id) · tags(mailbox)
//   │        · assignees(mailbox) · conversations(filter) · conversation-counts
//   │        · notifications ─ { unread }
//   └─ local ─ pending(threadId) · failures       (client-only state, never fetched)
//
// Switching organization or account clears the whole cache (see `session.ts`), so keys do not
// carry the org id.
import type { ConversationFilter, ThreadFilter } from "./types.ts";

export interface NotificationFilter {
  unread: boolean;
}

const root = ["omni"] as const;
const mail = [...root, "mail"] as const;
const org = [...root, "org"] as const;
const local = [...root, "local"] as const;

/** A filter with absent fields dropped, so `{ mailbox: undefined }` and `{}` share a key. */
function normalize(filter: ThreadFilter): ThreadFilter {
  return {
    view: filter.view,
    ...(filter.mailbox ? { mailbox: filter.mailbox } : {}),
    ...(filter.lane ? { lane: filter.lane } : {}),
  };
}

export const keys = {
  root,
  session: () => [...root, "session"] as const,
  deviceSessions: () => [...root, "device-sessions"] as const,
  /** The signed-in user's sessions on every device (not the accounts on this browser). */
  sessions: () => [...root, "sessions"] as const,
  signInMethods: () => [...root, "sign-in-methods"] as const,
  /** The addresses this person signs in with (ADR 0014). */
  signInEmails: () => [...root, "sign-in-emails"] as const,

  org: () => org,
  organizations: () => [...org, "organizations"] as const,
  members: () => [...org, "members"] as const,
  invitations: () => [...org, "invitations"] as const,
  invitation: (id: string) => [...org, "invitation", id] as const,
  passkeys: () => [...org, "passkeys"] as const,
  billing: () => [...org, "billing"] as const,
  /** The workspace's saved cards in Stripe (owners and admins). */
  billingCards: () => [...org, "billing-cards"] as const,
  /** The workspace's Stripe invoices (owners and admins). */
  billingInvoices: () => [...org, "billing-invoices"] as const,
  onboarding: () => [...org, "onboarding"] as const,
  /** Every org the user belongs to, with setup state and mailboxes (the switcher). */
  workspaces: () => [...org, "workspaces"] as const,

  mail: () => mail,
  mailboxes: () => [...mail, "mailboxes"] as const,
  /** Every mailbox of the workspace, without its mail (owners and admins). */
  workspaceMailboxes: () => [...mail, "workspace-mailboxes"] as const,
  mailboxMembers: (mailboxId: string) => [...mail, "mailbox-members", mailboxId] as const,
  counts: () => [...mail, "counts"] as const,
  threadLists: () => [...mail, "threads"] as const,
  threads: (filter: ThreadFilter) => [...mail, "threads", normalize(filter)] as const,
  thread: (id: string) => [...mail, "thread", id] as const,
  /**
   * A helpdesk conversation's status, assignee, priority, tags and events. Under `thread(id)`, so
   * whatever refetches the thread (realtime, an action) refetches this too.
   */
  conversation: (threadId: string) => [...mail, "thread", threadId, "conversation"] as const,
  /** A shared inbox's tags. */
  tags: (mailboxId: string) => [...mail, "tags", mailboxId] as const,
  /** Every helpdesk list (one shared inbox's view, optionally a tag). */
  conversationLists: () => [...mail, "conversations"] as const,
  conversations: (filter: ConversationFilter) =>
    [
      ...mail,
      "conversations",
      { mailbox: filter.mailbox, view: filter.view, ...(filter.tag ? { tag: filter.tag } : {}) },
    ] as const,
  /** Every shared inbox's view and tag counts, for the navigation. */
  conversationCounts: () => [...mail, "conversation-counts"] as const,
  /** Who a shared inbox's conversations can be assigned to. */
  assignees: (mailboxId: string) => [...mail, "assignees", mailboxId] as const,
  /** Your notifications: every list (all, unread only). Under `mail`, so a reconnect refetches them. */
  notifications: () => [...mail, "notifications"] as const,
  notificationList: (filter: NotificationFilter) =>
    [...mail, "notifications", { unread: filter.unread }] as const,
  searches: () => [...mail, "search"] as const,
  search: (q: string, mailbox?: string) =>
    [...mail, "search", { q, ...(mailbox ? { mailbox } : {}) }] as const,
  action: (id: string) => [...mail, "action", id] as const,

  /** App-only state, never fetched (`query-client.ts` keeps it forever). */
  local: () => local,
  pendingAll: () => [...local, "pending"] as const,
  pending: (threadId: string) => [...local, "pending", threadId] as const,
  failures: () => [...local, "failures"] as const,
};

/** Reads the filter back out of a `keys.threads(...)` key. */
export function filterOf(queryKey: readonly unknown[]): ThreadFilter | undefined {
  const filter = queryKey[3];
  return typeof filter === "object" && filter !== null ? (filter as ThreadFilter) : undefined;
}

/** Reads the filter back out of a `keys.conversations(...)` key. */
export function conversationFilterOf(queryKey: readonly unknown[]): ConversationFilter | undefined {
  const filter = queryKey[3];
  return typeof filter === "object" && filter !== null ? (filter as ConversationFilter) : undefined;
}

/** Reads the filter back out of a `keys.notificationList(...)` key. */
export function notificationFilterOf(queryKey: readonly unknown[]): NotificationFilter | undefined {
  const filter = queryKey[3];
  return typeof filter === "object" && filter !== null ? (filter as NotificationFilter) : undefined;
}
