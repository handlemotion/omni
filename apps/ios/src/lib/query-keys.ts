/** Every query key in the app, in one place, so invalidation can't miss one. */
export const keys = {
  workspaces: () => ["workspaces"] as const,
  mailboxes: () => ["mailboxes"] as const,
  counts: () => ["counts"] as const,
  threads: (page: string, mailboxId: string | undefined) =>
    ["threads", page, mailboxId ?? "all"] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
};
