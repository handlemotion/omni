import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from "@tanstack/react-query";
import { api, call, inWorkspace, isAuthError } from "./api.ts";
import type { NotificationPage } from "./notification-text.ts";
import { keys } from "./query-keys.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

const PAGE_SIZE = 30;

const BADGE_REFRESH_MS = 60_000;

/** Newest first, paged by an opaque cursor; with `unread`, only unread ones. */
export const notificationsQuery = (unread: boolean) =>
  infiniteQueryOptions({
    queryKey: keys.notificationList(unread),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.notifications.$get(
          {
            query: {
              unread: unread ? "true" : "false",
              limit: String(PAGE_SIZE),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** One list, flattened for `InfiniteList`. */
export const useNotifications = (unread: boolean) =>
  useInfiniteQuery({
    ...notificationsQuery(unread),
    select: (data) => data.pages.flatMap((page) => page.notifications),
  });

/**
 * Your unread count, as every page carries it: the bell's badge. With no live socket on the
 * phone, it catches up every minute while a module page is open.
 */
export const useUnreadNotifications = () =>
  useInfiniteQuery({
    ...notificationsQuery(false),
    select: (data) => data.pages[0]?.unread ?? 0,
    refetchInterval: BADGE_REFRESH_MS,
  }).data ?? 0;

type Pages = InfiniteData<NotificationPage, string | null>;

/**
 * `mutate({ ids, workspace })` marks those read, `mutate({ workspace })` every one, as the web's
 * does: unread-only lists drop them and every list's count goes down at once; the lists refetch
 * when it settles. `workspace` is `currentWorkspaceId()` when the person acts, so a retry after a
 * workspace switch still marks the right ones, and a failure never restores the old workspace's
 * list over the new one.
 */
export function useMarkNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, workspace }: { ids?: string[]; workspace: string | null }) =>
      call(api.notifications.read.$post({ json: ids ? { ids } : {} }, inWorkspace(workspace))),
    retry: (count, error) => !isAuthError(error) && count < 2,
    onMutate: async ({ ids }) => {
      await client.cancelQueries({ queryKey: keys.notifications() });
      const snapshot: [QueryKey, Pages | undefined][] = client.getQueriesData<Pages>({
        queryKey: keys.notifications(),
      });
      const now = new Date().toISOString();
      const marks = (id: string) => !ids || ids.includes(id);
      const marking = new Set<string>();
      for (const [, data] of snapshot) {
        for (const page of data?.pages ?? []) {
          for (const n of page.notifications) if (!n.readAt && marks(n.id)) marking.add(n.id);
        }
      }
      const marked = ids ? marking.size : Infinity;
      for (const [key, data] of snapshot) {
        if (!data) continue;
        const unreadOnly = (key[1] as { unread?: boolean } | undefined)?.unread === true;
        client.setQueryData<Pages>(key, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            unread: Math.max(0, page.unread - marked),
            notifications: unreadOnly
              ? page.notifications.filter((n) => !marks(n.id))
              : page.notifications.map((n) =>
                  !n.readAt && marks(n.id) ? { ...n, readAt: now } : n,
                ),
          })),
        });
      }
      return { snapshot };
    },
    onError: (_error, { workspace }, context) => {
      if (workspace !== currentWorkspaceId()) return;
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: keys.notifications() }),
  });
}
