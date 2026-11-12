// Your notifications: assigned to you, @mentioned in a note, a customer replied. They refetch
// when the realtime socket says a new one arrived.
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { markNotificationsReadMutation, notificationsQuery } from "../lib/notifications.ts";

/**
 * Newest first: `notifications` is every loaded page flattened (each has `kind`, `threadId`,
 * `mailboxId`, `subject`, `actorMemberId`, `readAt`), `unread` is your total unread count. With
 * `{ unread: true }`, only unread ones. Call `fetchNextPage` near the end.
 */
export function useNotifications(options: { unread?: boolean } = {}) {
  const query = useInfiniteQuery(notificationsQuery(options));
  const notifications = useMemo(
    () => query.data?.pages.flatMap((page) => page.notifications) ?? [],
    [query.data],
  );
  return { ...query, notifications, unread: query.data?.pages[0]?.unread ?? 0 };
}

/** `mutate({ ids })` marks those read; `mutate({})` marks every one read. Shows at once. */
export function useMarkNotificationsRead() {
  return useMutation(markNotificationsReadMutation(useQueryClient()));
}
