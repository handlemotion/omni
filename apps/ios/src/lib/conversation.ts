import type { Api } from "@omni/client";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api, call, inWorkspace, isAuthError } from "./api.ts";
import { idempotencyKey } from "./ids.ts";
import { keys } from "./query-keys.ts";
import { alertFailure } from "./thread-actions.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

/** A shared inbox's state for one thread: status, assignee, priority, tags (the web's). */
export type Conversation = InferResponseType<Api["threads"][":id"]["conversation"]["$get"], 200>;
export type ConversationStatus = Conversation["status"];
export type Priority = Conversation["priority"];
export type Tag = InferResponseType<Api["mailboxes"][":id"]["tags"]["$get"], 200>["tags"][number];
export type Assignee = InferResponseType<
  Api["mailboxes"][":id"]["assignees"]["$get"],
  200
>["assignees"][number];

/** What a property menu changes, as the web's `ConversationChange`. */
export type ConversationChange =
  | { type: "resolve" }
  | { type: "reopen" }
  | { type: "assign"; memberId: string | null }
  | { type: "priority"; priority: Priority }
  | { type: "tag"; tag: Tag; add: boolean };

/** Only for a shared inbox's thread: a personal one has no conversation state (409). */
export const useConversation = (threadId: string, enabled: boolean) =>
  useQuery({
    ...queryOptions({
      queryKey: keys.conversation(threadId),
      queryFn: ({ signal }) =>
        call(
          api.threads[":id"].conversation.$get({ param: { id: threadId } }, { init: { signal } }),
        ),
    }),
    enabled,
  });

/** Who the inbox's conversations can be assigned to. */
export const useAssignees = (mailboxId: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.assignees(mailboxId),
    queryFn: ({ signal }) =>
      call(api.mailboxes[":id"].assignees.$get({ param: { id: mailboxId } }, { init: { signal } })),
    select: (data) => data.assignees,
    enabled,
    staleTime: 5 * 60_000,
  });

/** The inbox's tags. */
export const useTags = (mailboxId: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.tags(mailboxId),
    queryFn: ({ signal }) =>
      call(api.mailboxes[":id"].tags.$get({ param: { id: mailboxId } }, { init: { signal } })),
    select: (data) => data.tags,
    enabled,
    staleTime: 5 * 60_000,
  });

function request(
  threadId: string,
  change: ConversationChange,
  key: string,
  workspace: string | null,
) {
  const param = { id: threadId };
  const header = { "idempotency-key": key };
  const options = inWorkspace(workspace);
  const thread = api.threads[":id"];
  switch (change.type) {
    case "resolve":
      return call(thread.resolve.$post({ param, header }, options));
    case "reopen":
      return call(thread.reopen.$post({ param, header }, options));
    case "assign":
      return call(
        thread.assignee.$put({ param, header, json: { memberId: change.memberId } }, options),
      );
    case "priority":
      return call(
        thread.priority.$put({ param, header, json: { priority: change.priority } }, options),
      );
    case "tag":
      return call(
        change.add
          ? thread.tags.$post({ param, header, json: { tagId: change.tag.id } }, options)
          : thread.tags[":tagId"].$delete(
              { param: { ...param, tagId: change.tag.id }, header },
              options,
            ),
      );
  }
}

function applied(before: Conversation, change: ConversationChange) {
  switch (change.type) {
    case "resolve":
      return { ...before, status: "resolved", snoozedUntil: null } satisfies Conversation;
    case "reopen":
      return { ...before, status: "open", snoozedUntil: null } satisfies Conversation;
    case "assign":
      return { ...before, assigneeMemberId: change.memberId } satisfies Conversation;
    case "priority":
      return { ...before, priority: change.priority } satisfies Conversation;
    case "tag": {
      const rest = before.tags.filter((t) => t.id !== change.tag.id);
      const { id, name, color } = change.tag;
      return {
        ...before,
        tags: change.add ? [...rest, { id, name, color }] : rest,
      } satisfies Conversation;
    }
  }
}

/**
 * `mutate(change)`: one change to the thread's conversation, as the web's property menus make it.
 * It shows at once; a failure puts it back and says why, unless the workspace changed since.
 * Changes to one thread queue behind each other, so a quick on-then-off lands in that order.
 */
export function useConversationChange(threadId: string) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (vars: { change: ConversationChange; key: string; workspace: string | null }) =>
      request(threadId, vars.change, vars.key, vars.workspace),
    scope: { id: `conversation:${threadId}` },
    retry: (count, error) => !isAuthError(error) && count < 2,
    onMutate: async ({ change }) => {
      const key: QueryKey = keys.conversation(threadId);
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData<Conversation>(key);
      if (before) client.setQueryData(key, applied(before, change));
      return { before };
    },
    onError: (error, vars, context) => {
      if (vars.workspace === currentWorkspaceId()) {
        client.setQueryData(keys.conversation(threadId), context?.before);
      }
      alertFailure(error);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.conversation(threadId) });
      void client.invalidateQueries({ queryKey: keys.threadLists() });
      void client.invalidateQueries({ queryKey: keys.counts() });
    },
  });
  return (change: ConversationChange) =>
    mutation.mutate({ change, key: idempotencyKey(), workspace: currentWorkspaceId() });
}
