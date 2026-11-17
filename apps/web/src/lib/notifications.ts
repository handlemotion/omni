import {
  infiniteQueryOptions,
  mutationOptions,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys, notificationFilterOf } from "./query-keys.ts";
import type { NotificationPage } from "./types.ts";

/** Notifications per page. */
export const NOTIFICATION_PAGE_SIZE = 30;

/** Newest first, paged by an opaque cursor. Every page carries the total `unread` count. */
export const notificationsQuery = (options: { unread?: boolean } = {}) =>
  infiniteQueryOptions({
    queryKey: keys.notificationList({ unread: options.unread ?? false }),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.notifications.$get(
          {
            query: {
              unread: options.unread ? "true" : "false",
              limit: String(NOTIFICATION_PAGE_SIZE),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

type NotificationPages = InfiniteData<NotificationPage, string | null>;

/**
 * Marks these notifications read, or all of them without `ids`. Unread-only lists drop them and
 * every list's `unread` count goes down at once; the lists refetch when the request settles.
 */
export const markNotificationsReadMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.notifications(), "read"],
    mutationFn: ({ ids }: { ids?: string[] | undefined }) =>
      call(api.notifications.read.$post({ json: ids ? { ids } : {} })),
    onMutate: async ({ ids }) => {
      await client.cancelQueries({ queryKey: keys.notifications() });
      const snapshot: [QueryKey, unknown][] = client.getQueriesData({
        queryKey: keys.notifications(),
      });
      const now = new Date().toISOString();
      const marks = (id: string) => !ids || ids.includes(id);
      const marking = new Set<string>();
      for (const [, data] of snapshot) {
        for (const page of (data as NotificationPages | undefined)?.pages ?? []) {
          for (const n of page.notifications) if (!n.readAt && marks(n.id)) marking.add(n.id);
        }
      }
      const marked = ids ? marking.size : Infinity;
      for (const [key, data] of snapshot) {
        const pages = data as NotificationPages | undefined;
        if (!pages) continue;
        const unreadOnly = notificationFilterOf(key)?.unread === true;
        client.setQueryData<NotificationPages>(key, {
          ...pages,
          pages: pages.pages.map((page) => ({
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
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: keys.notifications() }),
  });
