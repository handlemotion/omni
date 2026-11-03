// Every query key in the app, in one tree, so invalidation can target a branch:
//
//   omni
//   ├─ session · device-sessions · sign-in-methods
//   ├─ org ─ organizations · members · invitations · invitation(id) · passkeys
//   ├─ mail ─ mailboxes · counts · threads(filter) · thread(id) · search(q) · action(id)
//   └─ local ─ pending(threadId) · failures       (client-only state, never fetched)
//
// Switching organization or account clears the whole cache (see `session.ts`), so keys do not
// carry the org id.
import type { ThreadFilter } from "./types.ts";

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
  signInMethods: () => [...root, "sign-in-methods"] as const,

  org: () => org,
  organizations: () => [...org, "organizations"] as const,
  members: () => [...org, "members"] as const,
  invitations: () => [...org, "invitations"] as const,
  invitation: (id: string) => [...org, "invitation", id] as const,
  passkeys: () => [...org, "passkeys"] as const,

  mail: () => mail,
  mailboxes: () => [...mail, "mailboxes"] as const,
  counts: () => [...mail, "counts"] as const,
  threadLists: () => [...mail, "threads"] as const,
  threads: (filter: ThreadFilter) => [...mail, "threads", normalize(filter)] as const,
  thread: (id: string) => [...mail, "thread", id] as const,
  searches: () => [...mail, "search"] as const,
  search: (q: string, mailbox?: string) =>
    [...mail, "search", { q, ...(mailbox ? { mailbox } : {}) }] as const,
  action: (id: string) => [...mail, "action", id] as const,

  pendingAll: () => [...local, "pending"] as const,
  pending: (threadId: string) => [...local, "pending", threadId] as const,
  failures: () => [...local, "failures"] as const,
};

/** Reads the filter back out of a `keys.threads(...)` key. */
export function filterOf(queryKey: readonly unknown[]): ThreadFilter | undefined {
  const filter = queryKey[3];
  return typeof filter === "object" && filter !== null ? (filter as ThreadFilter) : undefined;
}
