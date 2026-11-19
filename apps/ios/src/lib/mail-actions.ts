import type { Thread, ThreadPage, ThreadSummary } from "@omni/client";
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { api, call, inWorkspace, isAuthError } from "./api.ts";
import { idempotencyKey } from "./ids.ts";
import { MAIL_ACTIONS_KEY, MAIL_ACTIONS_SCOPE, settleMailAction, type MailPage } from "./mail.ts";
import { keys } from "./query-keys.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

type Threads = InfiniteData<ThreadPage>;

interface Change {
  apply: (thread: ThreadSummary) => ThreadSummary | null;
  pages?: MailPage[];
  read?: boolean;
}

const INBOX_LISTS: MailPage[] = ["inbox", "needsReply", "awaitingReply"];

async function changeCachedThread(client: QueryClient, threadId: string, change: Change) {
  await client.cancelQueries({ queryKey: ["threads"] });
  const snapshot = client.getQueriesData<Threads>({ queryKey: ["threads"] });
  const lists = {
    queryKey: ["threads"],
    predicate: (query: { queryKey: readonly unknown[] }) =>
      !change.pages || (change.pages as readonly unknown[]).includes(query.queryKey[1]),
  };
  client.setQueriesData<Threads>(lists, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            threads: page.threads.flatMap((t) => {
              if (t.id !== threadId) return [t];
              const next = change.apply(t);
              return next ? [next] : [];
            }),
          })),
        }
      : data,
  );
  return snapshot;
}

type Send = (
  thread: ThreadSummary,
  key: string,
  workspace: ReturnType<typeof inWorkspace>,
) => Promise<unknown>;

function useThreadAction(send: Send, change: Change) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ thread, key, workspace }: Action) => send(thread, key, inWorkspace(workspace)),
    retry: (count, error) => !isAuthError(error) && count < 2,
    mutationKey: MAIL_ACTIONS_KEY,
    scope: MAIL_ACTIONS_SCOPE,
    onMutate: async ({ thread, workspace }) => {
      void Haptics.selectionAsync();
      const detail: [QueryKey, unknown] = [
        keys.thread(thread.id),
        client.getQueryData(keys.thread(thread.id)),
      ];
      if (change.read !== undefined)
        client.setQueryData<Thread>(keys.thread(thread.id), (data) =>
          data ? { ...data, read: change.read ?? data.read } : data,
        );
      const lists = await changeCachedThread(client, thread.id, change);
      return { snapshot: [...lists, detail], workspace };
    },
    onError: (_error, _vars, context) => {
      if (context?.workspace === currentWorkspaceId()) {
        for (const [key, data] of context.snapshot) client.setQueryData(key, data);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    },
    onSettled: () => settleMailAction(client),
  });
}

interface Action {
  thread: ThreadSummary;
  key: string;
  workspace: string | null;
}

const runner = (mutation: ReturnType<typeof useThreadAction>) => (thread: ThreadSummary) =>
  mutation.mutate({ thread, key: idempotencyKey(), workspace: currentWorkspaceId() });

/** Done: off the list, through its latest message (a newer reply brings it back). */
export function useDone() {
  return runner(
    useThreadAction(
      (thread, key, workspace) =>
        call(
          api.threads[":id"].done.$post(
            {
              param: { id: thread.id },
              header: { "idempotency-key": key },
              json: { through: thread.lastMessageAt },
            },
            workspace,
          ),
        ),
      { apply: () => null, pages: [...INBOX_LISTS, "later"] },
    ),
  );
}

/** Later: off the Inbox, onto Later. */
export function useLater() {
  return runner(
    useThreadAction(
      (thread, key, workspace) =>
        call(
          api.threads[":id"].later.$post(
            { param: { id: thread.id }, header: { "idempotency-key": key } },
            workspace,
          ),
        ),
      { apply: () => null, pages: INBOX_LISTS },
    ),
  );
}

/** Mark unread (or read): the row's weight follows at once. */
export function useMarkUnread() {
  return runner(
    useThreadAction(
      (thread, key, workspace) =>
        call(
          api.threads[":id"].state.$patch(
            { param: { id: thread.id }, header: { "idempotency-key": key }, json: { read: false } },
            workspace,
          ),
        ),
      { apply: (thread) => ({ ...thread, read: false, unread: true }), read: false },
    ),
  );
}
