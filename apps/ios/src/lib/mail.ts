// Read queries for mail, the web app's (`apps/web/src/lib/mail-queries.ts`) on the phone: every
// list spans every workspace the person belongs to (`scope: "all"`), each row with its `orgId`.
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import type { Mailbox } from "@omni/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

const FIRST_PAGE_SIZE = 30;
const OLDER_PAGE_SIZE = 100;

export const mailboxesQuery = () =>
  queryOptions({
    queryKey: keys.mailboxes(),
    queryFn: ({ signal }) =>
      call(api.mailboxes.$get({ query: { scope: "all" } }, { init: { signal } })),
    select: (data) => data.mailboxes,
    staleTime: 5 * 60_000,
  });

/** Unread inbox threads per mailbox, for the switcher's badges. */
export const countsQuery = () =>
  queryOptions({
    queryKey: keys.counts(),
    queryFn: ({ signal }) =>
      call(api.counts.$get({ query: { scope: "all" } }, { init: { signal } })),
    select: (data) => data.counts,
  });

/** The inbox, newest first; without a mailbox, every inbox the person can open. */
export const inboxQuery = (mailboxId: string | undefined) =>
  infiniteQueryOptions({
    queryKey: keys.threads(mailboxId),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.threads.$get(
          {
            query: {
              scope: "all",
              view: "inbox",
              ...(mailboxId ? { mailboxId } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: String(pageParam ? OLDER_PAGE_SIZE : FIRST_PAGE_SIZE),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.threads),
  });

export const useMailboxes = () => useQuery(mailboxesQuery());
export const useCounts = () => useQuery(countsQuery());
export const useInbox = (mailboxId: string | undefined) => useInfiniteQuery(inboxQuery(mailboxId));

/** What a mailbox is called, as on the web: you, for your own; its local part for a shared one. */
export function mailboxName(mailbox: Pick<Mailbox, "kind" | "address">, you: string) {
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** A list row's time: the clock today, the date before. */
export function listTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  return date.toDateString() === now.toDateString() ? TIME.format(date) : DAY.format(date);
}
