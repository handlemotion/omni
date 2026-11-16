// Every query key in the app, in one tree, so invalidation can target a branch:
//
//   omni
//   ├─ session · device-sessions · sessions · sign-in-methods · sign-in-emails
//   ├─ org ─ organizations · members · invitations · invitation(id) · passkeys · onboarding
//   │        · workspaces · billing · billing-cards · billing-invoices
//   ├─ mail ─ mailboxes(·all) · google-accounts · workspace-mailboxes · mailbox-members(id) · counts · threads(filter)
//   │        · thread(id) ─ conversation · search(q) · action(id) · tags(mailbox)
//   │        · assignees(mailbox) · conversations(filter) · conversation-counts
//   │        · notifications ─ { unread } · sla(mailbox)
//   ├─ storage ─ list(place) · trash · usage · sharing(id) · shared-with-me · link(share, node)
//   │                                                                  (ADR 0034)
//   ├─ crm ─ companies(q) · people(q) · deals(q) · company(id) · person(id) · deal(id) · stages
//   │        · timeline(kind, id) · contracts(where) · find(q)                  (ADR 0036)
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
const storage = [...root, "storage"] as const;
const crm = [...root, "crm"] as const;
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
  /** The company a scoped sign-in may ask to join (ADR 0024). */
  join: () => [...root, "join"] as const,
  /** An agent asking to connect over OAuth (ADR 0029). */
  oauthClients: () => [...root, "oauth-clients"] as const,

  org: () => org,
  organizations: () => [...org, "organizations"] as const,
  members: () => [...org, "members"] as const,
  invitations: () => [...org, "invitations"] as const,
  joinRequests: () => [...org, "join-requests"] as const,
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
  /** Every mailbox the user can open, in every workspace (ADR 0024): where they can send from. */
  allMailboxes: () => [...mail, "mailboxes", "all"] as const,
  /** Your personal mailboxes in every workspace, with their CRM forwarding (ADR 0032). */
  forwarding: () => [...mail, "forwarding"] as const,
  /** Whether Google can be connected here, and the member's connected Gmail accounts. */
  googleAccounts: () => [...mail, "google-accounts"] as const,
  /** Every mailbox of the workspace, without its mail (owners and admins). */
  workspaceMailboxes: () => [...mail, "workspace-mailboxes"] as const,
  /** Every member with the inboxes each can open (owners and admins). */
  workspaceMembers: () => [...mail, "workspace-members"] as const,
  /** Each member's role and each shared inbox's tags, for triage (owners and admins). */
  aiSettings: () => [...mail, "ai-settings"] as const,
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
  /** A shared inbox's SLA targets, business hours and auto-assign. */
  sla: (mailboxId: string) => [...mail, "sla", mailboxId] as const,
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
  /** An inbox's signature and the member's own on it. */
  signatures: (mailboxId: string) => [...mail, "signatures", mailboxId] as const,
  /** An inbox's canned replies with the member's own. */
  cannedReplies: (mailboxId: string) => [...mail, "canned-replies", mailboxId] as const,
  customerSearch: (q: string) => [...mail, "customers", { q }] as const,
  /** Shared drafts: one conversation's, or an inbox's new mail. */
  draftLists: () => [...mail, "drafts"] as const,
  drafts: (where: { threadId: string } | { mailboxId?: string | undefined }) =>
    [...mail, "drafts", where] as const,

  /** Storage (ADR 0034): every folder listing, Trash and usage. */
  storage: () => storage,
  /** One folder's contents: a space's root, or a folder by id. */
  storageList: (place: { space: string } | { parentId: string }) =>
    [...storage, "list", place] as const,
  storageTrash: () => [...storage, "trash"] as const,
  storageUsage: () => [...storage, "usage"] as const,
  /** Who a file or folder is shared with, and its link. */
  storageSharing: (nodeId: string) => [...storage, "sharing", nodeId] as const,
  storageSharedWithMe: () => [...storage, "shared-with-me"] as const,
  /** What a link opens: the shared node, or a folder inside it. */
  storageLink: (shareId: string, nodeId: string | undefined) =>
    [...storage, "link", shareId, nodeId ?? null] as const,

  /** The CRM (ADR 0036): every list, record, timeline and the stages. */
  crm: () => crm,
  crmCompanies: (q: string) => [...crm, "companies", { q }] as const,
  crmPeople: (q: string) => [...crm, "people", { q }] as const,
  /** Every deals list (the board's and the searched ones), so a move patches them all. */
  crmDealLists: () => [...crm, "deals"] as const,
  crmDeals: (q: string) => [...crm, "deals", { q }] as const,
  crmCompany: (id: string) => [...crm, "company", id] as const,
  crmPerson: (id: string) => [...crm, "person", id] as const,
  crmDeal: (id: string) => [...crm, "deal", id] as const,
  crmStages: () => [...crm, "stages"] as const,
  crmTimeline: (kind: string, id: string) => [...crm, "timeline", kind, id] as const,
  crmContracts: (where: { company: string } | { deal: string }) =>
    [...crm, "contracts", where] as const,
  /** People, companies and deals whose name starts with `q`, for pickers. */
  crmFind: (q: string) => [...crm, "find", { q }] as const,

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
