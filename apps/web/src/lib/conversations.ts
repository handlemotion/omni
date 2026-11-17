import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import { removeFromLists } from "./cache.ts";
import { FIRST_PAGE_SIZE, OLDER_PAGE_SIZE } from "./mail-queries.ts";
import { conversationFilterOf, keys } from "./query-keys.ts";
import type {
  Assignee,
  Conversation,
  ConversationFilter,
  ConversationPage,
  ConversationSummary,
  Priority,
} from "./types.ts";

/** One helpdesk list, paged by an opaque cursor kept in the cache. `sla_at_risk` is soonest due first. */
export const conversationsQuery = (filter: ConversationFilter) =>
  infiniteQueryOptions({
    queryKey: keys.conversations(filter),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.conversations.$get(
          {
            query: {
              mailboxId: filter.mailbox,
              view: filter.view,
              ...(filter.tag ? { tagId: filter.tag } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: String(pageParam ? OLDER_PAGE_SIZE : FIRST_PAGE_SIZE),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** Every shared inbox's view and tag counts, for the navigation's badges. */
export const conversationCountsQuery = () =>
  queryOptions({
    queryKey: keys.conversationCounts(),
    queryFn: ({ signal }) =>
      call(api.conversations.counts.$get({ query: {} }, { init: { signal } })),
    select: (data) => data.counts,
  });

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
  | { type: "snooze"; until: string }
  | { type: "claim"; memberId?: string | undefined }
  | { type: "assign"; memberId: string | null }
  | { type: "priority"; priority: Priority }
  | { type: "tag"; tagId: string; add: boolean };

export interface ChangeVariables {
  key: string;
  threadId: string;
  change: ConversationChange;
  /** Your member in the inbox's workspace, when known: decides whether a row stays in Mine. */
  me?: string | undefined;
}

const retry = (failureCount: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && failureCount < 10;

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

/** The shared state a change touches; a conversation and a list row both carry it. */
export type ConversationState = Pick<
  Conversation,
  "status" | "snoozedUntil" | "resolvedAt" | "assigneeMemberId" | "priority" | "tags"
>;

const SLA_AT_RISK_MS = 30 * 60_000;

/**
 * Whether a row in this state belongs in the list, by the same rules as the server's views.
 * `me` is your member in the inbox's workspace; without it `mine` is unknown (`undefined`),
 * and an unknown row stays until the refetch decides.
 */
export function inView(
  row: ConversationState & { slaDueAt: string | null },
  filter: ConversationFilter,
  me: string | undefined,
) {
  if (filter.tag && !row.tags.some((t) => t.id === filter.tag)) return false;
  switch (filter.view) {
    case "unassigned":
      return row.status === "open" && row.assigneeMemberId === null;
    case "mine":
      if (row.status !== "open" && row.status !== "pending") return false;
      return me === undefined ? undefined : row.assigneeMemberId === me;
    case "open":
    case "pending":
    case "snoozed":
    case "resolved":
      return row.status === filter.view;
    case "sla_at_risk":
      if (row.status !== "open") return false;
      return row.slaDueAt !== null && Date.parse(row.slaDueAt) <= Date.now() + SLA_AT_RISK_MS;
    case "all":
      return true;
  }
}

type ConversationPages = InfiniteData<ConversationPage, string | null>;

function patchLists(
  client: QueryClient,
  { threadId, change, tag, me }: ChangeVariables & { tag?: Conversation["tags"][number] },
) {
  for (const query of client.getQueryCache().findAll({ queryKey: keys.conversationLists() })) {
    const filter = conversationFilterOf(query.queryKey);
    if (!filter) continue;
    client.setQueryData<ConversationPages>(query.queryKey, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              conversations: page.conversations.flatMap((row) => {
                if (row.id !== threadId) return [row] satisfies ConversationSummary[];
                const next = applyChange(row, change, tag);
                return (
                  inView(next, filter, me) === false ? [] : [next]
                ) satisfies ConversationSummary[];
              }),
            })),
          }
        : data,
    );
  }
}

/**
 * What the conversation looks like right after `change`, as the server will compute it. Tags
 * need the tag itself (`tag`), which only the caller has: without it an added tag shows on the
 * refetch.
 */
export const applyChange: <T extends ConversationState>(
  conversation: T,
  change: ConversationChange,
  tag?: Conversation["tags"][number],
) => T = (conversation, change, tag) => {
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
};

/**
 * The change that puts back what `change` replaced, from the conversation as it was. Reopen is
 * the inverse of resolve and snooze, so a pending conversation comes back open.
 */
export const inverseOf: (
  before: ConversationState,
  change: ConversationChange,
) => ConversationChange | null = (before, change) => {
  switch (change.type) {
    case "resolve":
    case "snooze":
    case "reopen": {
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
};

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
    onMutate: async (vars) => {
      const { threadId, change, tag } = vars;
      const key = keys.conversation(threadId);
      await Promise.all([
        client.cancelQueries({ queryKey: key }),
        client.cancelQueries({ queryKey: keys.conversationLists() }),
        client.cancelQueries({ queryKey: keys.threadLists() }),
      ]);
      const snapshot: [QueryKey, unknown][] = [
        [key, client.getQueryData(key)],
        ...client.getQueriesData({ queryKey: keys.conversationLists() }),
        ...client.getQueriesData({ queryKey: keys.threadLists() }),
      ];
      const before = client.getQueryData<Conversation>(key);
      if (before) client.setQueryData(key, applyChange(before, change, tag));
      patchLists(client, vars);
      if (change.type === "resolve") removeFromLists(client, threadId, (f) => f.view === "inbox");
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },
    onSuccess: ({ conversation }, { threadId }) => {
      client.setQueryData<Conversation>(keys.conversation(threadId), (current) =>
        current ? { ...current, ...conversation } : current,
      );
    },
    onSettled: (_data, _error, { threadId }) => {
      void client.invalidateQueries({ queryKey: keys.thread(threadId) });
      void client.invalidateQueries({ queryKey: keys.conversationLists() });
      void client.invalidateQueries({ queryKey: keys.conversationCounts() });
      void client.invalidateQueries({ queryKey: keys.threadLists() });
      void client.invalidateQueries({ queryKey: keys.counts() });
    },
  });

/** Most conversations one bulk request takes (the Worker's cap); `useBulkChange` splits bigger batches. */
export const BULK_MAX = 100;

export interface BulkVariables {
  key: string;
  /** Up to `BULK_MAX`. */
  threadIds: string[];
  change: ConversationChange;
  tag?: Conversation["tags"][number] | undefined;
  me?: string | undefined;
}

type ListSnapshot = [QueryKey, ConversationPages | undefined][];

function restoreRows(
  client: QueryClient,
  failed: Set<string>,
  details: Map<string, Conversation | undefined>,
  lists: ListSnapshot,
) {
  for (const id of failed) client.setQueryData(keys.conversation(id), details.get(id));
  for (const [key, old] of lists) {
    client.setQueryData<ConversationPages>(key, (current) => {
      if (!old || !current) return current;
      const now = new Map(current.pages.flatMap((p) => p.conversations).map((r) => [r.id, r]));
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          conversations: page.conversations.flatMap((row) => {
            if (failed.has(row.id)) return [row];
            const kept = now.get(row.id);
            return kept ? [kept] : [];
          }),
        })),
      };
    });
  }
}

/**
 * One change to many conversations in one request (`POST /conversations/bulk`). Every row shows
 * the change at once; the server applies each on its own and answers per row, so only the rows it
 * refused roll back. A retry reuses the key, and the server skips the rows it already changed.
 */
export const bulkChangeMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "conversation", "bulk"],
    retry,
    scope,
    mutationFn: ({ key, threadIds, change }: BulkVariables) =>
      call(
        api.conversations.bulk.$post({
          header: { "idempotency-key": key },
          json: { threadIds, change: change.type === "claim" ? { type: "claim" } : change },
        }),
      ),
    onMutate: async (vars) => {
      await Promise.all([
        ...vars.threadIds.map((id) => client.cancelQueries({ queryKey: keys.conversation(id) })),
        client.cancelQueries({ queryKey: keys.conversationLists() }),
      ]);
      const details = new Map<string, Conversation | undefined>();
      const lists: ListSnapshot = client.getQueriesData<ConversationPages>({
        queryKey: keys.conversationLists(),
      });
      for (const threadId of vars.threadIds) {
        const key = keys.conversation(threadId);
        const before = client.getQueryData<Conversation>(key);
        details.set(threadId, before);
        if (before) client.setQueryData(key, applyChange(before, vars.change, vars.tag));
        patchLists(client, { ...vars, threadId });
      }
      return { details, lists };
    },
    onError: (_error, vars, context) => {
      if (context) restoreRows(client, new Set(vars.threadIds), context.details, context.lists);
    },
    onSuccess: ({ results }, _vars, context) => {
      const failed = new Set(results.filter((r) => !r.ok).map((r) => r.threadId));
      if (failed.size && context) restoreRows(client, failed, context.details, context.lists);
    },
    onSettled: (_data, _error, { threadIds }) => {
      for (const id of threadIds) void client.invalidateQueries({ queryKey: keys.thread(id) });
      void client.invalidateQueries({ queryKey: keys.conversationLists() });
      void client.invalidateQueries({ queryKey: keys.conversationCounts() });
      void client.invalidateQueries({ queryKey: keys.threadLists() });
      void client.invalidateQueries({ queryKey: keys.counts() });
    },
  });

/** Creates a tag on the inbox; a name that exists (ignoring case) answers that tag. */
export const createTagMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
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
    meta: { handlesError: true },
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
      void client.invalidateQueries({ queryKey: keys.mail(), predicate: isConversation });
    },
  });

/** Deletes a tag and takes it off every conversation. */
export const deleteTagMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ mailboxId, tagId }: { mailboxId: string; tagId: string }) =>
      call(api.mailboxes[":id"].tags[":tagId"].$delete({ param: { id: mailboxId, tagId } })),
    onSettled: (_data, _error, { mailboxId }) => {
      void client.invalidateQueries({ queryKey: keys.tags(mailboxId) });
      void client.invalidateQueries({ queryKey: keys.mail(), predicate: isConversation });
      void client.invalidateQueries({ queryKey: keys.conversationLists() });
      void client.invalidateQueries({ queryKey: keys.conversationCounts() });
    },
  });

const isConversation = (query: { queryKey: readonly unknown[] }) =>
  query.queryKey.at(-1) === "conversation";

/**
 * The conversation's shared state as the screen shows it: its detail if loaded, else its row in
 * any cached helpdesk list (acting from the list never loads the detail).
 */
export const cachedState: (
  client: QueryClient,
  threadId: string,
) => (ConversationState & { mailboxId: string }) | undefined = (client, threadId) => {
  const detail = client.getQueryData<Conversation>(keys.conversation(threadId));
  if (detail) return detail;
  for (const [, data] of client.getQueriesData<ConversationPages>({
    queryKey: keys.conversationLists(),
  })) {
    for (const page of data?.pages ?? []) {
      const row = page.conversations.find((r) => r.id === threadId);
      if (row) return row;
    }
  }
  return undefined;
};

/**
 * Your member in the inbox's workspace, from its cached assignee list (lists span workspaces,
 * so the session alone does not say which member you are there). `undefined` until it loads.
 */
export function memberInInbox(
  client: QueryClient,
  mailboxId: string | undefined,
  email: string | undefined,
) {
  if (!mailboxId || !email) return undefined;
  return client
    .getQueryData<{ assignees: Assignee[] }>(keys.assignees(mailboxId))
    ?.assignees.find((a) => a.email === email)?.memberId;
}
