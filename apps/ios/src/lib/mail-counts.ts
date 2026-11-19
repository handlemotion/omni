import { useQuery } from "@tanstack/react-query";
import { countsQuery, type MailPage } from "./mail.ts";

const unreadBadge = (count: number) => (count > 99 ? "99+" : countOrNothing(count));
const countOrNothing = (count: number) => (count ? String(count) : undefined);

/** Unread inbox threads in every mailbox here, for the Mail tab's badge. */
export function useInboxUnread(enabled: boolean) {
  const counts = useQuery({ ...countsQuery(), enabled }).data ?? [];
  return unreadBadge(counts.reduce((sum, c) => sum + c.unread, 0));
}

/**
 * The counts the web sidebar shows beside Mail's pages, in one mailbox or all: unread for Inbox,
 * the lane's threads for Needs reply and Awaiting reply.
 */
export function useMailPageCounts(mailboxId: string | undefined) {
  const counts = (useQuery(countsQuery()).data ?? []).filter(
    (c) => !mailboxId || c.mailboxId === mailboxId,
  );
  const sum = (count: (c: (typeof counts)[number]) => number) =>
    counts.reduce((acc, c) => acc + count(c), 0);
  return {
    inbox: unreadBadge(sum((c) => c.unread)),
    needsReply: countOrNothing(sum((c) => c.lanes.needs_reply)),
    awaitingReply: countOrNothing(sum((c) => c.lanes.waiting_on_them)),
  } satisfies Partial<Record<MailPage, string | undefined>>;
}

/** Mail's pages for the page menu, each with its count. */
export function useCountedPages<Page extends { id: MailPage }>(
  pages: readonly Page[],
  mailboxId: string | undefined,
) {
  const counts: Partial<Record<MailPage, string | undefined>> = useMailPageCounts(mailboxId);
  return pages.map((page) => ({ ...page, count: counts[page.id] }));
}
