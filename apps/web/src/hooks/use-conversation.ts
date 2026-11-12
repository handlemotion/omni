// Helpdesk conversations on shared inboxes: state, tags, assignees, and the changes to them.
// Every change shows at once, rolls back if the request fails, and offers its inverse as undo
// (`useUndo()` shows it; `z` runs it).
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import {
  assigneesQuery,
  cachedState,
  conversationChangeMutation,
  conversationCountsQuery,
  conversationQuery,
  conversationsQuery,
  createTagMutation,
  deleteTagMutation,
  inverseOf,
  memberInInbox,
  tagsQuery,
  updateTagMutation,
  type ConversationChange,
} from "../lib/conversations.ts";
import { idempotencyKey } from "../lib/api.ts";
import { keys } from "../lib/query-keys.ts";
import { offerUndo } from "../lib/undo.ts";
import type { Assignee, ConversationFilter, Priority, Tag } from "../lib/types.ts";
import { useSession } from "./use-session.ts";

/**
 * Status, assignee, priority, SLA due times, tags and timeline events of a conversation, or
 * `undefined` while loading. 409 for a personal mailbox's thread (no helpdesk state there).
 */
export function useConversation(threadId: string, options: { enabled?: boolean } = {}) {
  return useQuery({ ...conversationQuery(threadId), enabled: options.enabled ?? true });
}

/**
 * One helpdesk list: `{ mailbox, view, tag? }`. `conversations` is every loaded page flattened
 * (rows carry status, assignee, priority, tags and `slaDueAt`); call `fetchNextPage` near the end.
 */
export function useConversations(filter: ConversationFilter) {
  const query = useInfiniteQuery(conversationsQuery(filter));
  const conversations = useMemo(
    () => query.data?.pages.flatMap((page) => page.conversations) ?? [],
    [query.data],
  );
  return { ...query, conversations };
}

/**
 * Per shared inbox: `{ orgId, mailboxId, views: { unassigned, mine, open, … }, tags: { [tagId]: n } }`,
 * for the navigation's counts. Refetches whenever a conversation changes.
 */
export function useConversationCounts() {
  return useQuery(conversationCountsQuery());
}

/** The inbox's tags, by name. */
export function useTags(mailboxId: string | undefined) {
  return useQuery({ ...tagsQuery(mailboxId ?? ""), enabled: !!mailboxId });
}

/** Who the inbox's conversations can be assigned to: `{ memberId, name, email, image }`. */
export function useAssignees(mailboxId: string | undefined) {
  return useQuery({ ...assigneesQuery(mailboxId ?? ""), enabled: !!mailboxId });
}

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** What a change did, for the undo toast and the screen reader. */
function describe(change: ConversationChange, client: QueryClient, mailboxId?: string) {
  const assignee = (memberId: string | null) =>
    memberId
      ? (client
          .getQueryData<{ assignees: Assignee[] }>(keys.assignees(mailboxId ?? ""))
          ?.assignees.find((a) => a.memberId === memberId)?.name ?? "a teammate")
      : null;
  switch (change.type) {
    case "resolve":
      return "Resolved";
    case "reopen":
      return "Reopened";
    case "snooze":
      return "Snoozed";
    case "claim":
      return "Assigned to you";
    case "assign":
      return change.memberId ? `Assigned to ${assignee(change.memberId)}` : "Unassigned";
    case "priority":
      return `Priority ${PRIORITY_LABELS[change.priority] ?? change.priority}`;
    case "tag":
      return change.add ? "Tag added" : "Tag removed";
  }
}

/**
 * `change(threadId, change, { tag? })`: the one entry point for conversation changes, used by
 * the named hooks below. Offers the inverse as undo unless `undo: false` (an undo itself).
 */
function useChange() {
  const client = useQueryClient();
  const email = useSession().data?.user.email;
  const mutation = useMutation(conversationChangeMutation(client));
  const run = (
    threadId: string,
    change: ConversationChange,
    options: { tag?: Tag; undo?: boolean; mailboxId?: string } = {},
  ) => {
    const before = cachedState(client, threadId);
    const me = memberInInbox(client, options.mailboxId ?? before?.mailboxId, email);
    mutation.mutate({ key: idempotencyKey(), threadId, change, tag: options.tag, me });
    const inverse = before && options.undo !== false ? inverseOf(before, change) : null;
    if (!inverse) return;
    const tag =
      inverse.type === "tag" ? before?.tags.find((t) => t.id === inverse.tagId) : undefined;
    offerUndo(describe(change, client, before?.mailboxId), () =>
      mutation.mutate({ key: idempotencyKey(), threadId, change: inverse, tag, me }),
    );
  };
  return { ...mutation, run };
}

/** `mutate({ threadId })`: resolved, its mail filed out of INBOX. A customer reply reopens it. */
export function useResolve() {
  const { run, ...rest } = useChange();
  return {
    ...rest,
    mutate: ({ threadId }: { threadId: string }) => run(threadId, { type: "resolve" }),
  };
}

/** `mutate({ threadId })`: open again, its mail back in INBOX. */
export function useReopen() {
  const { run, ...rest } = useChange();
  return {
    ...rest,
    mutate: ({ threadId }: { threadId: string }) => run(threadId, { type: "reopen" }),
  };
}

/** `mutate({ threadId, until })`: out of Open until `until` (a future `Date`). */
export function useSnooze() {
  const { run, ...rest } = useChange();
  return {
    ...rest,
    mutate: ({ threadId, until }: { threadId: string; until: Date }) =>
      run(threadId, { type: "snooze", until: until.toISOString() }),
  };
}

/** `mutate({ threadId, mailboxId })`: assigned to you. */
export function useClaim() {
  const { run, ...rest } = useChange();
  const client = useQueryClient();
  const email = useSession().data?.user.email;
  return {
    ...rest,
    mutate: ({ threadId, mailboxId }: { threadId: string; mailboxId: string }) =>
      // Your member, for the optimistic avatar; the server assigns whoever asks anyway.
      run(
        threadId,
        { type: "claim", memberId: memberInInbox(client, mailboxId, email) },
        { mailboxId },
      ),
  };
}

/** `mutate({ threadId, memberId })`: assigned to that member, or unassigned with `null`. */
export function useAssign() {
  const { run, ...rest } = useChange();
  return {
    ...rest,
    mutate: ({ threadId, memberId }: { threadId: string; memberId: string | null }) =>
      run(threadId, { type: "assign", memberId }),
  };
}

/** `mutate({ threadId, priority })`. */
export function useSetPriority() {
  const { run, ...rest } = useChange();
  return {
    ...rest,
    mutate: ({ threadId, priority }: { threadId: string; priority: Priority }) =>
      run(threadId, { type: "priority", priority }),
  };
}

/** `mutate({ threadId, tag, add })`: pass the whole tag so it shows before the server answers. */
export function useToggleTag() {
  const { run, ...rest } = useChange();
  return {
    ...rest,
    mutate: ({ threadId, tag, add }: { threadId: string; tag: Tag; add: boolean }) =>
      run(threadId, { type: "tag", tagId: tag.id, add }, { tag }),
  };
}

/** `mutate({ mailboxId, name, color? })`; resolves with `{ tag }` (an existing one by name). */
export function useCreateTag() {
  return useMutation(createTagMutation(useQueryClient()));
}

/** `mutate({ mailboxId, tagId, name?, color? })`. Fails with 409 on a taken name. */
export function useUpdateTag() {
  return useMutation(updateTagMutation(useQueryClient()));
}

/** `mutate({ mailboxId, tagId })`: deletes it and takes it off every conversation. */
export function useDeleteTag() {
  return useMutation(deleteTagMutation(useQueryClient()));
}

/**
 * For lists acting on many rows at once: `run(threadId, change, { undo: false })` applies one
 * change with no undo of its own (the caller offers one for the batch, from `inverseOf`), and
 * `me` is your member in that inbox's workspace when its assignees are cached.
 */
export function useConversationChanges() {
  const { run, ...rest } = useChange();
  const client = useQueryClient();
  const email = useSession().data?.user.email;
  return { ...rest, run, me: (mailboxId: string) => memberInInbox(client, mailboxId, email) };
}
