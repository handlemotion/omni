import type { Thread, ThreadPage, ThreadSummary } from "@omni/client";
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { Alert } from "react-native";
import { ApiError, api, call, inWorkspace } from "./api.ts";
import { idempotencyKey } from "./ids.ts";
import {
  MAIL_ACTIONS_KEY,
  MAIL_ACTIONS_SCOPE,
  MAIL_PAGES,
  isMailPage,
  settleMailAction,
} from "./mail.ts";
import { keys } from "./query-keys.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

type ThreadPages = InfiniteData<ThreadPage, string | null>;
type Snapshot = [QueryKey, unknown][];
type ThreadPatch = Partial<ThreadSummary> & Partial<Thread>;

const LEAVES = {
  done: ["inbox", "later"],
  undone: ["done"],
  later: ["inbox", "done"],
  unlater: ["later"],
  archive: ["inbox", "later"],
  trash: ["inbox", "later", "sent", "spam"],
  spam: ["inbox", "later", "trash"],
  notSpam: ["spam"],
} as const satisfies Record<string, readonly string[]>;

export type ThreadAction = keyof typeof LEAVES;

/** True when `action` takes the thread out of the mail page `page` (a `MAIL_PAGES` key). */
export function leavesPage(action: ThreadAction, page: string | undefined) {
  if (!isMailPage(page)) return false;
  return (LEAVES[action] as readonly string[]).includes(MAIL_PAGES[page].view);
}

async function snapshotThread(client: QueryClient, threadId: string) {
  await Promise.all([
    client.cancelQueries({ queryKey: keys.threadLists() }),
    client.cancelQueries({ queryKey: keys.thread(threadId), exact: true }),
  ]);
  return [
    ...client.getQueriesData({ queryKey: keys.threadLists() }),
    [keys.thread(threadId), client.getQueryData(keys.thread(threadId))],
  ] satisfies Snapshot;
}

function restore(client: QueryClient, snapshot: Snapshot | undefined) {
  for (const [key, data] of snapshot ?? []) client.setQueryData(key, data);
}

function mapPages(data: ThreadPages | undefined, fn: (page: ThreadPage) => ThreadPage) {
  return data ? { ...data, pages: data.pages.map(fn) } : data;
}

function patchThread(client: QueryClient, threadId: string, patch: ThreadPatch) {
  client.setQueriesData<ThreadPages>({ queryKey: keys.threadLists() }, (data) =>
    mapPages(data, (page) => ({
      ...page,
      threads: page.threads.map((row) => (row.id === threadId ? { ...row, ...patch } : row)),
    })),
  );
  client.setQueryData<Thread>(keys.thread(threadId), (thread) =>
    thread ? { ...thread, ...patch } : thread,
  );
}

function removeFromLists(client: QueryClient, threadId: string, action: ThreadAction) {
  for (const query of client.getQueryCache().findAll({ queryKey: keys.threadLists() })) {
    const page = query.queryKey[1];
    if (typeof page !== "string" || !leavesPage(action, page)) continue;
    client.setQueryData<ThreadPages>(query.queryKey, (data) =>
      mapPages(data, (one) => ({
        ...one,
        threads: one.threads.filter((row) => row.id !== threadId),
      })),
    );
  }
}

function failureText(error: unknown) {
  if (!(error instanceof ApiError)) return "Something went wrong.";
  if (error.status === 0) return "You're offline.";
  if (error.status === 403) return "You don't have access to that.";
  if (error.status === 404) return "That's no longer here.";
  if (error.status === 429) return "Too many at once. Try again in a minute.";
  if (error.status === 503) return "That's unavailable right now. Try again soon.";
  if (error.status >= 500) return "Something went wrong. Try again.";
  return "That didn't go through.";
}

function alertFailure(error: unknown, title?: string) {
  if (error instanceof ApiError && error.status === 401) return;
  if (title) Alert.alert(title);
  else Alert.alert(failureText(error));
}

const retry = (count: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && count < 10;

const header = (key: string) => ({ "idempotency-key": key });

type Options = ReturnType<typeof inWorkspace>;

interface Sent {
  key: string;
  workspace: string | null;
}

interface ThreadMutation<V extends { threadId: string }> {
  request: (vars: V, key: string, options: Options) => Promise<unknown>;
  patch?: (vars: V) => ThreadPatch;
  leaves?: (vars: V) => ThreadAction;
}

function useThreadMutation<V extends { threadId: string }>(spec: ThreadMutation<V>) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (vars: V & Sent) => spec.request(vars, vars.key, inWorkspace(vars.workspace)),
    retry,
    mutationKey: MAIL_ACTIONS_KEY,
    scope: MAIL_ACTIONS_SCOPE,
    onMutate: async (vars) => {
      const { workspace } = vars;
      const snapshot = await snapshotThread(client, vars.threadId);
      if (spec.patch) patchThread(client, vars.threadId, spec.patch(vars));
      if (spec.leaves) removeFromLists(client, vars.threadId, spec.leaves(vars));
      return { snapshot, workspace };
    },
    onError: (error, _vars, context) => {
      if (context?.workspace === currentWorkspaceId()) restore(client, context.snapshot);
      alertFailure(error);
    },
    onSettled: () => settleMailAction(client),
  });
  return {
    isPending: mutation.isPending,
    mutate: (vars: V) =>
      mutation.mutate({ ...vars, key: idempotencyKey(), workspace: currentWorkspaceId() }),
  };
}

const thread = (threadId: string) => ({ param: { id: threadId } });

/**
 * `mutate({ threadId, through: thread.lastMessageAt })`. Done for you alone, out of the Inbox and
 * Later; a newer message brings it back.
 */
export const useDone = () =>
  useThreadMutation<{ threadId: string; through: string }>({
    request: ({ threadId, through }, key, options) =>
      call(
        api.threads[":id"].done.$post(
          { ...thread(threadId), header: header(key), json: { through } },
          options,
        ),
      ),
    patch: () => ({ done: true, later: false }),
    leaves: () => "done",
  });

/** `mutate({ threadId })`: not done, back in the Inbox. */
export const useUndone = () =>
  useThreadMutation<{ threadId: string }>({
    request: ({ threadId }, key, options) =>
      call(api.threads[":id"].done.$delete({ ...thread(threadId), header: header(key) }, options)),
    patch: () => ({ done: false }),
    leaves: () => "undone",
  });

/**
 * `mutate({ threadId, later: true })` moves it into Later until you bring it back; with `until`,
 * until then (a snooze). `later: false` puts it back in the Inbox, snoozed or not.
 */
export const useLater = () =>
  useThreadMutation<{ threadId: string; later: boolean; until?: Date }>({
    request: ({ threadId, later, until }, key, options) => {
      const request = { ...thread(threadId), header: header(key) };
      if (!later) return call(api.threads[":id"].later.$delete(request, options));
      if (until) {
        return call(
          api.threads[":id"].defer.$post(
            { ...request, json: { until: until.toISOString() } },
            options,
          ),
        );
      }
      return call(api.threads[":id"].later.$post(request, options));
    },
    patch: ({ later }) => ({ later, ...(later ? { done: false } : {}) }),
    leaves: ({ later }) => (later ? "later" : "unlater"),
  });

/** `mutate({ threadId })`: out of the Inbox and Later, kept in Archive. */
export const useArchive = () =>
  useThreadMutation<{ threadId: string }>({
    request: ({ threadId }, key, options) =>
      call(api.threads[":id"].archive.$post({ ...thread(threadId), header: header(key) }, options)),
    patch: () => ({ archived: true }),
    leaves: () => "archive",
  });

/** `mutate({ threadId })`: every copy goes to the mailbox's Trash. */
export const useTrash = () =>
  useThreadMutation<{ threadId: string }>({
    request: ({ threadId }, key, options) =>
      call(api.threads[":id"].trash.$post({ ...thread(threadId), header: header(key) }, options)),
    patch: () => ({ archived: true }),
    leaves: () => "trash",
  });

/**
 * `mutate({ threadId, spam: true })` moves every copy to the mailbox's Junk folder; `false` moves
 * them from Junk back to the Inbox.
 */
export const useSpam = () =>
  useThreadMutation<{ threadId: string; spam: boolean }>({
    request: ({ threadId, spam }, key, options) => {
      const request = { ...thread(threadId), header: header(key) };
      return call(
        spam
          ? api.threads[":id"].spam.$post(request, options)
          : api.threads[":id"]["not-spam"].$post(request, options),
      );
    },
    patch: ({ spam }) => ({ archived: spam }),
    leaves: ({ spam }) => (spam ? "spam" : "notSpam"),
  });

/** `mutate({ threadId, read })`: read state, yours alone on a shared mailbox. */
export const useMarkUnread = () =>
  useThreadMutation<{ threadId: string; read: boolean }>({
    request: ({ threadId, read }, key, options) =>
      call(
        api.threads[":id"].state.$patch(
          { ...thread(threadId), header: header(key), json: { read } },
          options,
        ),
      ),
    patch: ({ read }) => ({ read, unread: !read }),
  });

/**
 * `mutate({ threadId, messageId })`: leaves the mailing list that message came from (one-click or
 * mailto; a list that only offers a page is opened instead, by the caller).
 */
export function useUnsubscribe() {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      threadId,
      messageId,
      key,
      workspace,
    }: { threadId: string; messageId: string } & Sent) =>
      call(
        api.threads[":id"].unsubscribe.$post(
          { ...thread(threadId), header: header(key), json: { messageId } },
          inWorkspace(workspace),
        ),
      ),
    retry,
    mutationKey: MAIL_ACTIONS_KEY,
    scope: MAIL_ACTIONS_SCOPE,
    onSettled: () => settleMailAction(client),
    onError: (error) => alertFailure(error, "Unsubscribe failed"),
  });
  return {
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    mutate: (vars: { threadId: string; messageId: string }) =>
      mutation.mutate({ ...vars, key: idempotencyKey(), workspace: currentWorkspaceId() }),
  };
}

/** The web's snooze presets: three hours from now, tomorrow at 8, next Monday at 8. */
export function snoozePresets(now = new Date()) {
  const at8 = (days: number) => {
    const day = new Date(now);
    day.setDate(day.getDate() + days);
    day.setHours(8, 0, 0, 0);
    return day;
  };
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { id: "later", label: "Later today", until: new Date(now.getTime() + 3 * 3_600_000) },
    { id: "tomorrow", label: "Tomorrow", until: at8(1) },
    { id: "week", label: "Next week", until: at8(toMonday) },
  ];
}
