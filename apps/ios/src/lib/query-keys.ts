/** Every query key in the app, in one place, so invalidation can't miss one. */
export const keys = {
  workspaces: () => ["workspaces"] as const,
  mailboxes: () => ["mailboxes"] as const,
  counts: () => ["counts"] as const,
  threads: (page: string, mailboxId: string | undefined) =>
    ["threads", page, mailboxId ?? "all"] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
  /** A shared inbox's conversation state (status, assignee, priority, tags) for one thread. */
  conversation: (threadId: string) => ["conversation", threadId] as const,
  assignees: (mailboxId: string) => ["assignees", mailboxId] as const,
  tags: (mailboxId: string) => ["tags", mailboxId] as const,
  drive: (page: string, folderId?: string) => ["drive", page, folderId ?? "root"] as const,
  /**
   * A Drive file's local copy, and its text, per version: outside `["drive"]`, so a change in
   * Drive (a rename, an upload) never cancels or repeats a download in flight.
   */
  fileCopy: (fileId: string, version: string) => ["drive-file", "copy", fileId, version] as const,
  fileText: (fileId: string, version: string) => ["drive-file", "text", fileId, version] as const,
  storageHeaders: () => ["storage-headers"] as const,
  /** One kind's lists (`companies`, `people`, `deals`), each order and filter apart. */
  crmList: (records: string, query?: Record<string, string>) =>
    query ? (["crm", records, query] as const) : (["crm", records] as const),
  crmSettings: () => ["crm", "settings"] as const,
  crmRecord: (kind: string, id: string) => ["crm", kind, id] as const,
  crmStages: () => ["crm", "stages"] as const,
  crmTimeline: (kind: string, id: string) => ["crm", "timeline", kind, id] as const,
  crmCompanySearch: (q: string) => ["crm", "company-search", q] as const,
  crmMe: () => ["crm-me"] as const,
  crmMembers: () => ["crm-members"] as const,
  me: () => ["me"] as const,
  /** The workspace's plan (`{ enabled: false }` without billing). */
  billing: () => ["billing"] as const,
  /** Where workspace setup stands, and whether you may start another workspace. */
  onboarding: () => ["onboarding"] as const,
  /** Everything Drive caches, to ask it all again after a change. */
  driveAll: () => ["drive"] as const,
  driveNode: (nodeId: string) => ["drive", "node", nodeId] as const,
  driveSharing: (nodeId: string) => ["drive", "sharing", nodeId] as const,
  driveVersions: (nodeId: string) => ["drive", "versions", nodeId] as const,
  /** Prefixes, for invalidating a whole module at once. */
  threadLists: () => ["threads"] as const,
  threadDetails: () => ["thread"] as const,
  conversations: () => ["conversation"] as const,
  crmAll: () => ["crm"] as const,
  /** Your notifications: every list (all, unread only). */
  notifications: () => ["notifications"] as const,
  notificationList: (unread: boolean) => ["notifications", { unread }] as const,
  senderLogo: (who: string) => ["sender-logo", who] as const,
  search: (q: string) => ["search", q] as const,
  driveSearch: (q: string) => ["drive", "search", q] as const,
  crmSearch: (q: string) => ["crm", "search", q] as const,
  attachmentFile: (attachmentId: string) => ["attachment", attachmentId] as const,
};
