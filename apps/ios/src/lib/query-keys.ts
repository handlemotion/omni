/** Every query key in the app, in one place, so invalidation can't miss one. */
export const keys = {
  workspaces: () => ["workspaces"] as const,
  mailboxes: () => ["mailboxes"] as const,
  counts: () => ["counts"] as const,
  threads: (page: string, mailboxId: string | undefined) =>
    ["threads", page, mailboxId ?? "all"] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
  drive: (page: string, folderId?: string) => ["drive", page, folderId ?? "root"] as const,
  fileSource: (fileId: string) => ["drive", "file", fileId] as const,
  crmList: (page: string) => ["crm", page] as const,
  crmRecord: (kind: string, id: string) => ["crm", kind, id] as const,
  crmStages: () => ["crm", "stages"] as const,
  /** Every cached thread list, whatever its page and mailbox (`threads(...)` is under it). */
  threadLists: () => ["threads"] as const,
};
