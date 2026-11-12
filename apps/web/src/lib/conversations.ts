// Helpdesk conversations on shared inboxes (ADR 0021): reading a conversation's state and
// changing it. Every change is one shared value (status, assignee, priority, a tag) for everyone
// who sees the inbox; the Worker writes its timeline event and fans the change out over realtime.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { Conversation, Priority } from "./types.ts";

export const conversationQuery = (threadId: string) =>
  queryOptions({
    queryKey: keys.conversation(threadId),
    queryFn: ({ signal }) =>
      call(api.threads[":id"].conversation.$get({ param: { id: threadId } }, { init: { signal } })),
  });

export const tagsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.tags(mailboxId),
    queryFn: ({ signal }) =>
      call(api.mailboxes[":id"].tags.$get({ param: { id: mailboxId } }, { init: { signal } })),
    select: (data) => data.tags,
    // Tags change in settings, rarely; a change there invalidates this.
    staleTime: 5 * 60_000,
  });

export const assigneesQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.assignees(mailboxId),
    queryFn: ({ signal }) =>
      call(api.mailboxes[":id"].assignees.$get({ param: { id: mailboxId } }, { init: { signal } })),
    select: (data) => data.assignees,
    staleTime: 5 * 60_000,
  });

/** One change to a conversation, as the Worker's routes take them. */
export type ConversationChange =
  | { type: "resolve" }
  | { type: "reopen" }
  /** ISO 8601, in the future. */
  | { type: "snooze"; until: string }
  /** Assign to yourself. `memberId` (yours, when known) only drives the optimistic update. */
  | { type: "claim"; memberId?: string | undefined }
  /** `null` unassigns. */
  | { type: "assign"; memberId: string | null }
  | { type: "priority"; priority: Priority }
  | { type: "tag"; tagId: string; add: boolean };

export interface ChangeVariables {
  key: string;
  threadId: string;
  change: ConversationChange;
}

const retry = (failureCount: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && failureCount < 10;

/** The same scope as mail actions: everything runs in the order it was made, offline included. */
const scope = { id: "mail-actions" };

function request({ threadId, change, key }: ChangeVariables) {
  const param = { id: threadId };
  const header = { "idempotency-key": key };
  const thread = api.threads[":id"];
  switch (change.type) {
    case "resolve":
      return thread.resolve.$post({ param, header });
    case "reopen":
      return thread.reopen.$post({ param, header });
    case "snooze":
      return thread.snooze.$post({ param, header, json: { until: change.until } });
    case "claim":
      return thread.claim.$post({ param, header });
    case "assign":
      return thread.assignee.$put({ param, header, json: { memberId: change.memberId } });
    case "priority":
      return thread.priority.$put({ param, header, json: { priority: change.priority } });
    case "tag":
      return change.add
        ? thread.tags.$post({ param, header, json: { tagId: change.tagId } })
        : thread.tags[":tagId"].$delete({ param: { ...param, tagId: change.tagId }, header });
  }
}

/**
 * What the conversation looks like right after `change`, as the server will compute it. Tags
 * need the tag itself (`tag`), which only the caller has: without it an added tag shows on the
 * refetch.
 */
export function applyChange(
  conversation: Conversation,
  change: ConversationChange,
  tag?: Conversation["tags"][number],
): Conversation {
  const now = new Date().toISOString();
  switch (change.type) {
    case "resolve":
      return { ...conversation, status: "resolved", snoozedUntil: null, resolvedAt: now };
    case "reopen":
      return { ...conversation, status: "open", snoozedUntil: null, resolvedAt: null };
    case "snooze":
      return { ...conversation, status: "snoozed", snoozedUntil: change.until };
    case "claim":
      return change.memberId
        ? { ...conversation, assigneeMemberId: change.memberId }
        : conversation;
    case "assign":
      return { ...conversation, assigneeMemberId: change.memberId };
    case "priority":
      return { ...conversation, priority: change.priority };
    case "tag": {
      const others = conversation.tags.filter((t) => t.id !== change.tagId);
      if (!change.add) return { ...conversation, tags: others };
      return tag ? { ...conversation, tags: [...others, tag] } : conversation;
    }
  }
}

/**
 * The change that puts back what `change` replaced, from the conversation as it was. Reopen is
 * the inverse of resolve and snooze, so a pending conversation comes back open.
 */
export function inverseOf(
  before: Conversation,
  change: ConversationChange,
): ConversationChange | null {
  switch (change.type) {
    case "resolve":
    case "snooze":
    case "reopen": {
      // Back to the status it had: resolved, the same snooze (while still ahead), or open.
      const unchanged =
        (change.type === "resolve" && before.status === "resolved") ||
        (change.type === "reopen" && (before.status === "open" || before.status === "pending")) ||
        (change.type === "snooze" &&
          before.status === "snoozed" &&
          before.snoozedUntil === change.until);
      if (unchanged) return null;
      if (before.status === "resolved") return { type: "resolve" };
      const until = before.snoozedUntil;
      if (before.status === "snoozed" && until && Date.parse(until) > Date.now()) {
        return { type: "snooze", until };
      }
      return { type: "reopen" };
    }
    case "claim":
    case "assign":
      return before.assigneeMemberId === change.memberId
        ? null
        : { type: "assign", memberId: before.assigneeMemberId };
    case "priority":
      return before.priority === change.priority
        ? null
        : { type: "priority", priority: before.priority };
    case "tag": {
      const had = before.tags.some((t) => t.id === change.tagId);
      return had === change.add ? null : { type: "tag", tagId: change.tagId, add: had };
    }
  }
}

/**
 * Changes a conversation: shows the change at once, puts it back if the request fails, and
 * refetches the thread, the lists and the counts when it settles (a resolve leaves the Open
 * views, an assign moves it between Unassigned and Mine).
 */
export const conversationChangeMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "conversation"],
    retry,
    scope,
    mutationFn: (vars: ChangeVariables & { tag?: Conversation["tags"][number] }) =>
      call(request(vars)),
    onMutate: async ({ threadId, change, tag }) => {
      const key = keys.conversation(threadId);
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData<Conversation>(key);
      if (before) client.setQueryData(key, applyChange(before, change, tag));
      return { before };
    },
    onError: (_error, { threadId }, context) => {
      if (context?.before) client.setQueryData(keys.conversation(threadId), context.before);
    },
    onSuccess: ({ conversation }, { threadId }) => {
      // The server's values (due times, resolvedAt) over the guess; tags and events refetch.
      client.setQueryData<Conversation>(keys.conversation(threadId), (current) =>
        current ? { ...current, ...conversation } : current,
      );
    },
    onSettled: (_data, _error, { threadId }) => {
      void client.invalidateQueries({ queryKey: keys.thread(threadId) });
      void client.invalidateQueries({ queryKey: keys.threadLists() });
      void client.invalidateQueries({ queryKey: keys.counts() });
    },
  });

/** Creates a tag on the inbox; a name that exists (ignoring case) answers that tag. */
export const createTagMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      mailboxId,
      ...json
    }: {
      mailboxId: string;
      name: string;
      color?: string | null;
    }) => call(api.mailboxes[":id"].tags.$post({ param: { id: mailboxId }, json })),
    onSettled: (_data, _error, { mailboxId }) =>
      void client.invalidateQueries({ queryKey: keys.tags(mailboxId) }),
  });

/** Renames or recolors a tag. 409 when another tag of the inbox has that name. */
export const updateTagMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      mailboxId,
      tagId,
      ...json
    }: {
      mailboxId: string;
      tagId: string;
      name?: string;
      color?: string | null;
    }) =>
      call(api.mailboxes[":id"].tags[":tagId"].$patch({ param: { id: mailboxId, tagId }, json })),
    onSettled: (_data, _error, { mailboxId }) => {
      void client.invalidateQueries({ queryKey: keys.tags(mailboxId) });
      // Conversations show the tag's name and color.
      void client.invalidateQueries({ queryKey: keys.mail(), predicate: isConversation });
    },
  });

/** Deletes a tag and takes it off every conversation. */
export const deleteTagMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ mailboxId, tagId }: { mailboxId: string; tagId: string }) =>
      call(api.mailboxes[":id"].tags[":tagId"].$delete({ param: { id: mailboxId, tagId } })),
    onSettled: (_data, _error, { mailboxId }) => {
      void client.invalidateQueries({ queryKey: keys.tags(mailboxId) });
      void client.invalidateQueries({ queryKey: keys.mail(), predicate: isConversation });
      void client.invalidateQueries({ queryKey: keys.threadLists() });
    },
  });

const isConversation = (query: { queryKey: readonly unknown[] }) =>
  query.queryKey.at(-1) === "conversation";
