import type { Mailbox, ThreadSummary } from "@omni/client";
import { Link } from "expo-router";
import { useMemo } from "react";
import { IconCircleCheck, IconClock, IconInbox } from "@/components/icons.ts";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { SwipeRow } from "@/components/ui/swipe-row.tsx";
import {
  MAIL_PAGES,
  bySection,
  mailboxName,
  usePrefetchThread,
  useThreads,
  type MailPage,
} from "@/lib/mail.ts";
import {
  useArchive,
  useDone,
  useLater,
  useMarkUnread,
  useSpam,
  useTrash,
} from "@/lib/thread-actions.ts";
import { ThreadListSkeleton } from "./thread-list-skeleton.tsx";
import { ThreadRow } from "./thread-row.tsx";

export interface ThreadListProps {
  page: MailPage;
  /** One mailbox, or every inbox the person can open. */
  mailboxId: string | undefined;
  mailboxes: Mailbox[];
  you: string;
  /** Room past the last row, for what floats over the list's bottom. */
  footerSpace?: number;
}

/**
 * A mail page's threads, newest first under a heading per day, older ones as you scroll, pull
 * to refresh. A tap zooms the row open into the conversation, warmed as the finger lands; a long
 * press peeks at it, with its actions in a menu: Done, Later and Mark as read or unread; Archive
 * and Report spam; Move to trash. On the Inbox and its lane views a row swipes right for Done and left for Later; on
 * Later, right for Done.
 */
export function ThreadList({ page, mailboxId, mailboxes, you, footerSpace }: ThreadListProps) {
  const threads = useThreads(page, mailboxId);
  const actions = useRowActions();
  const prefetch = usePrefetchThread();
  const shared = useMemo(
    () =>
      new Map(
        mailboxId
          ? []
          : mailboxes.filter((m) => m.kind === "shared").map((m) => [m.id, mailboxName(m, you)]),
      ),
    [mailboxId, mailboxes, you],
  );
  const triaged = page === "inbox" || page === "needsReply" || page === "awaitingReply";
  const doneable = triaged || page === "later";
  return (
    <InfiniteList
      query={threads}
      rows={sections}
      keyOf={(row) => row.id}
      typeOf={(row) => row.kind}
      icon={IconInbox}
      empty={MAIL_PAGES[page].empty}
      skeleton={<ThreadListSkeleton />}
      footerSpace={footerSpace}
      renderItem={(row) =>
        row.kind === "heading" ? (
          <SectionHeading variant="group" label={row.label} />
        ) : (
          <SwipeRow
            itemKey={row.item.id}
            right={
              doneable
                ? {
                    label: "Done",
                    icon: IconCircleCheck,
                    tone: "success",
                    run: () => actions.done(row.item),
                  }
                : null
            }
            left={
              triaged
                ? {
                    label: "Later",
                    icon: IconClock,
                    tone: "warning",
                    run: () => actions.later(row.item),
                  }
                : null
            }
          >
            <Link
              href={{
                pathname: "/mail/thread/[id]",
                params: { id: row.item.id, page, ...(mailboxId ? { mailbox: mailboxId } : {}) },
              }}
              asChild
            >
              <Link.Trigger withAppleZoom>
                <ThreadRow
                  thread={{
                    ...row.item,
                    sender: row.item.latestFrom?.name || row.item.latestFrom?.address || "",
                    senderAddress: row.item.latestFrom?.address,
                  }}
                  sharedInbox={shared.get(row.item.mailboxId)}
                  onPressIn={() => prefetch(row.item.id)}
                />
              </Link.Trigger>
              <Link.Preview />
              <Link.Menu>
                <Link.Menu inline>
                  {triaged ? (
                    <Link.MenuAction icon="checkmark.circle" onPress={() => actions.done(row.item)}>
                      Done
                    </Link.MenuAction>
                  ) : null}
                  {triaged ? (
                    <Link.MenuAction icon="clock" onPress={() => actions.later(row.item)}>
                      Later
                    </Link.MenuAction>
                  ) : null}
                  <Link.MenuAction
                    icon={row.item.unread ? "envelope.open" : "envelope.badge"}
                    onPress={() => actions.read(row.item)}
                  >
                    {row.item.unread ? "Mark as read" : "Mark as unread"}
                  </Link.MenuAction>
                </Link.Menu>
                <Link.Menu inline>
                  {page === "archive" ? null : (
                    <Link.MenuAction icon="archivebox" onPress={() => actions.archive(row.item)}>
                      Archive
                    </Link.MenuAction>
                  )}
                  <Link.MenuAction
                    icon={page === "spam" ? "tray" : "exclamationmark.octagon"}
                    onPress={() => actions.spam(row.item, page !== "spam")}
                  >
                    {page === "spam" ? "Not spam" : "Report spam"}
                  </Link.MenuAction>
                </Link.Menu>
                {page === "trash" ? null : (
                  <Link.Menu inline>
                    <Link.MenuAction
                      icon="trash"
                      destructive
                      onPress={() => actions.trash(row.item)}
                    >
                      Move to trash
                    </Link.MenuAction>
                  </Link.Menu>
                )}
              </Link.Menu>
            </Link>
          </SwipeRow>
        )
      }
    />
  );
}

function useRowActions() {
  const done = useDone();
  const later = useLater();
  const read = useMarkUnread();
  const archive = useArchive();
  const spam = useSpam();
  const trash = useTrash();
  return {
    done: (thread: ThreadSummary) =>
      done.mutate({ threadId: thread.id, through: thread.lastMessageAt }),
    later: (thread: ThreadSummary) => later.mutate({ threadId: thread.id, later: true }),
    read: (thread: ThreadSummary) => read.mutate({ threadId: thread.id, read: thread.unread }),
    archive: (thread: ThreadSummary) => archive.mutate({ threadId: thread.id }),
    spam: (thread: ThreadSummary, into: boolean) =>
      spam.mutate({ threadId: thread.id, spam: into }),
    trash: (thread: ThreadSummary) => trash.mutate({ threadId: thread.id }),
  };
}

const sections = (threads: ThreadSummary[]) =>
  bySection(
    threads,
    (t) => t.id,
    (t) => t.lastMessageAt,
  );
