import { currentWorkspaceId } from "./current-workspace.ts";
import type { ConversationFilter, ThreadFilter } from "./types.ts";

export interface NotificationFilter {
  unread: boolean;
}

const root = ["omni"] as const;
const scoped = <const B extends string>(branch: B) =>
  [...root, currentWorkspaceId() ?? "", branch] as const;
const mail = () => scoped("mail");
const org = () => scoped("org");
const storage = () => scoped("storage");
const crm = () => scoped("crm");
const local = [...root, "local"] as const;
const preview = [...root, "preview"] as const;

function normalize(filter: ThreadFilter) {
  return {
    view: filter.view,
    ...(filter.mailbox ? { mailbox: filter.mailbox } : {}),
    ...(filter.lane ? { lane: filter.lane } : {}),
  } satisfies ThreadFilter;
}

export const keys = {
  root,
  session: () => [...root, "session"] as const,
  deviceSessions: () => [...root, "device-sessions"] as const,
  /** The signed-in user's sessions on every device (not the accounts on this browser). */
  sessions: () => [...root, "sessions"] as const,
  signInMethods: () => [...root, "sign-in-methods"] as const,
  /** The addresses this person signs in with. */
  signInEmails: () => [...root, "sign-in-emails"] as const,
  /** The company a scoped sign-in may ask to join. */
  join: () => [...root, "join"] as const,
  /** Invitations waiting for the signed-in person, to any of their sign-in emails. */
  pendingInvitations: () => [...root, "pending-invitations"] as const,
  /** One invitation as its `/invite/<id>` link shows it to the signed-in person. */
  invitationStatus: (id: string) => [...root, "invitation-status", id] as const,
  /** Drive sync on this computer, as the desktop shell reports it. */
  desktopSync: () => [...root, "desktop-sync"] as const,
  /** A sender's avatar picture and its edge, by address or company domain. The same everywhere. */
  senderLogo: (who: string) => [...root, "sender-logo", who] as const,
  /** An agent asking to connect over OAuth. */
  oauthClients: () => [...root, "oauth-clients"] as const,

  org: () => org(),
  organizations: () => [...org(), "organizations"] as const,
  members: () => [...org(), "members"] as const,
  invitations: () => [...org(), "invitations"] as const,
  joinRequests: () => [...org(), "join-requests"] as const,
  passkeys: () => [...org(), "passkeys"] as const,
  billing: () => [...org(), "billing"] as const,
  /** The workspace's saved cards in Stripe (owners and admins). */
  billingCards: () => [...org(), "billing-cards"] as const,
  /** The workspace's Stripe invoices (owners and admins). */
  billingInvoices: () => [...org(), "billing-invoices"] as const,
  onboarding: () => [...org(), "onboarding"] as const,
  /** Every org the user belongs to, with setup state and mailboxes (the switcher). */
  workspaces: () => [...root, "workspaces"] as const,

  mail: () => mail(),
  mailboxes: () => [...mail(), "mailboxes"] as const,
  /** Every mailbox the user can open, in every workspace: where they can send from. */
  allMailboxes: () => [...mail(), "mailboxes", "all"] as const,
  /** Your personal mailboxes in every workspace, with their CRM forwarding. */
  forwarding: () => [...mail(), "forwarding"] as const,
  /** Whether Google can be connected here, and the member's connected Gmail accounts. */
  googleAccounts: () => [...mail(), "google-accounts"] as const,
  /** Every mailbox of the workspace, without its mail (owners and admins). */
  workspaceMailboxes: () => [...mail(), "workspace-mailboxes"] as const,
  /** Every member with the inboxes each can open (owners and admins). */
  workspaceMembers: () => [...mail(), "workspace-members"] as const,
  /** Each member's role and each shared inbox's tags, for triage (owners and admins). */
  aiSettings: () => [...mail(), "ai-settings"] as const,
  mailboxMembers: (mailboxId: string) => [...mail(), "mailbox-members", mailboxId] as const,
  counts: () => [...mail(), "counts"] as const,
  threadLists: () => [...mail(), "threads"] as const,
  threads: (filter: ThreadFilter) => [...mail(), "threads", normalize(filter)] as const,
  thread: (id: string) => [...mail(), "thread", id] as const,
  /**
   * A helpdesk conversation's status, assignee, priority, tags and events. Under `thread(id)`, so
   * whatever refetches the thread (realtime, an action) refetches this too.
   */
  conversation: (threadId: string) => [...mail(), "thread", threadId, "conversation"] as const,
  /** A shared inbox's tags. */
  tags: (mailboxId: string) => [...mail(), "tags", mailboxId] as const,
  /** Every helpdesk list (one shared inbox's view, optionally a tag). */
  conversationLists: () => [...mail(), "conversations"] as const,
  conversations: (filter: ConversationFilter) =>
    [
      ...mail(),
      "conversations",
      { mailbox: filter.mailbox, view: filter.view, ...(filter.tag ? { tag: filter.tag } : {}) },
    ] as const,
  /** Every shared inbox's view and tag counts, for the navigation. */
  conversationCounts: () => [...mail(), "conversation-counts"] as const,
  /** A shared inbox's SLA targets, business hours and auto-assign. */
  sla: (mailboxId: string) => [...mail(), "sla", mailboxId] as const,
  /** Who a shared inbox's conversations can be assigned to. */
  assignees: (mailboxId: string) => [...mail(), "assignees", mailboxId] as const,
  /** Your notifications: every list (all, unread only). Under `mail`, so a reconnect refetches them. */
  notifications: () => [...mail(), "notifications"] as const,
  notificationList: (filter: NotificationFilter) =>
    [...mail(), "notifications", { unread: filter.unread }] as const,
  searches: () => [...mail(), "search"] as const,
  search: (q: string, mailbox?: string) =>
    [...mail(), "search", { q, ...(mailbox ? { mailbox } : {}) }] as const,
  action: (id: string) => [...mail(), "action", id] as const,
  /** An inbox's signature and the member's own on it. */
  signatures: (mailboxId: string) => [...mail(), "signatures", mailboxId] as const,
  /** An inbox's canned replies with the member's own. */
  cannedReplies: (mailboxId: string) => [...mail(), "canned-replies", mailboxId] as const,
  customerSearch: (q: string) => [...mail(), "customers", { q }] as const,
  /** Shared drafts: one conversation's, or an inbox's new mail. */
  draftLists: () => [...mail(), "drafts"] as const,
  drafts: (where: { threadId: string } | { mailboxId?: string | undefined }) =>
    [...mail(), "drafts", where] as const,

  /** Storage: every folder listing, Trash and usage. */
  storage: () => storage(),
  /** One folder's contents: a space's root, or a folder by id. */
  storageList: (place: { space: string } | { teamspaceId: string } | { parentId: string }) =>
    [...storage(), "list", place] as const,
  /** Every folder's contents. */
  storageLists: () => [...storage(), "list"] as const,
  storageTrash: () => [...storage(), "trash"] as const,
  /** Drive's Search for one query, and its filter when it has one. */
  storageSearch: (q: string, filter?: { drive?: string; type?: string }) =>
    [...storage(), "search", q, ...(filter ? [filter] : [])] as const,
  storageIcons: (space: string) => [...storage(), "icons", space] as const,
  storageUsage: () => [...storage(), "usage"] as const,
  /** The workspace's teamspaces the member reaches. */
  storageTeamspaces: () => [...storage(), "teamspaces"] as const,
  /** Who is in one teamspace. */
  storageTeamspaceMembers: (teamspaceId: string) =>
    [...storage(), "teamspaces", teamspaceId, "members"] as const,
  /** Where a node is now: its folder and space. */
  storageNode: (nodeId: string) => [...storage(), "node", nodeId] as const,
  /** Who a file or folder is shared with, and its link. */
  storageSharing: (nodeId: string) => [...storage(), "sharing", nodeId] as const,
  storageVersions: (nodeId: string) => [...storage(), "versions", nodeId] as const,
  storageComments: (nodeId: string) => [...storage(), "comments", nodeId] as const,
  /** A file's signature requests. */
  storageSignatures: (nodeId: string) => [...storage(), "signatures", nodeId] as const,
  /** A request the signed-in person was asked to sign. */
  signing: (requestId: string) => [...storage(), "signing", requestId] as const,
  storageSharedWithMe: () => [...storage(), "shared-with-me"] as const,
  /** What a link opens: the shared node, or a folder inside it. */
  storageLink: (shareId: string, nodeId: string | undefined) =>
    [...storage(), "link", shareId, nodeId ?? null] as const,
  /** The files still uploading behind a link, polled while there are any. */
  storageLinkUploading: (shareId: string, nodeId: string | undefined) =>
    [...storage(), "link-uploading", shareId, nodeId ?? null] as const,

  /** The client portal: projects the person is a client on, across workspaces. */
  portalProjects: () => ["portal", "projects"] as const,
  portalProject: (id: string) => ["portal", "project", id] as const,
  /** The CRM: every list, record, timeline and the stages. */
  crm: () => crm(),
  /** A list by every filter, sort and search it is asked with, so each view caches apart. */
  crmCompanies: (filter: object) => [...crm(), "companies", filter] as const,
  crmPeople: (filter: object) => [...crm(), "people", filter] as const,
  /** Every live company's name, for the Company columns. */
  crmCompanyIndex: () => [...crm(), "company-index"] as const,
  /** Every deals list (the board's and the searched ones), so a move patches them all. */
  crmDealLists: () => [...crm(), "deals"] as const,
  crmDeals: (filter: object) => [...crm(), "deals", filter] as const,
  crmCompany: (id: string) => [...crm(), "company", id] as const,
  crmPerson: (id: string) => [...crm(), "person", id] as const,
  crmDeal: (id: string) => [...crm(), "deal", id] as const,
  crmStages: () => [...crm(), "stages"] as const,
  crmSettings: () => [...crm(), "settings"] as const,
  crmTimeline: (kind: string, id: string) => [...crm(), "timeline", kind, id] as const,
  /** A project's milestones and deliverables. */
  crmPlan: (dealId: string) => [...crm(), "plan", dealId] as const,
  /** The people outside the team on a project. */
  crmAccess: (dealId: string) => [...crm(), "access", dealId] as const,
  crmContracts: (where: { company: string } | { deal: string }) =>
    [...crm(), "contracts", where] as const,
  /** People, companies and deals whose name starts with `q`, for pickers. */
  crmFind: (q: string) => [...crm(), "find", { q }] as const,
  /**
   * A file's preview: `image`, `thumbnail`, `text` or `sheets`, by the URL it is read
   * through and the file's `updatedAt`, so a new version is a new key.
   */
  storagePreview: (
    kind: "image" | "thumbnail" | "pdf-thumbnail" | "text" | "sheets",
    url: string,
    version: string,
  ) => [...preview, kind, url, version] as const,

  /** App-only state, never fetched (`query-client.ts` keeps it forever). */
  local: () => local,
  pendingAll: () => [...local, "pending"] as const,
  pending: (threadId: string) => [...local, "pending", threadId] as const,
  failures: () => [...local, "failures"] as const,
};

/** Reads the filter back out of a `keys.threads(...)` key. */
export const filterOf: (queryKey: readonly unknown[]) => ThreadFilter | undefined = (queryKey) => {
  const filter = queryKey[4];
  return typeof filter === "object" && filter !== null ? (filter as ThreadFilter) : undefined;
};

/** Reads the filter back out of a `keys.conversations(...)` key. */
export const conversationFilterOf: (
  queryKey: readonly unknown[],
) => ConversationFilter | undefined = (queryKey) => {
  const filter = queryKey[4];
  return typeof filter === "object" && filter !== null ? (filter as ConversationFilter) : undefined;
};

/** Reads the filter back out of a `keys.notificationList(...)` key. */
export const notificationFilterOf: (
  queryKey: readonly unknown[],
) => NotificationFilter | undefined = (queryKey) => {
  const filter = queryKey[4];
  return typeof filter === "object" && filter !== null ? (filter as NotificationFilter) : undefined;
};
