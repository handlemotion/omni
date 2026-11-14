/** Every query key in the app, in one place, so invalidation can't miss one. */
export const keys = {
  mailboxes: () => ["mailboxes", "all"] as const,
  counts: () => ["counts", "all"] as const,
  threads: (mailboxId: string | undefined) => ["threads", "inbox", mailboxId ?? "all"] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
};
