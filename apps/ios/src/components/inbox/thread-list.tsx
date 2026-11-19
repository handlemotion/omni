import type { Mailbox, ThreadSummary } from "@omni/client";
import { Link } from "expo-router";
import { useMemo } from "react";
import { IconInbox } from "@/components/icons.ts";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { useDone, useLater, useMarkUnread } from "@/lib/mail-actions.ts";
import { MAIL_PAGES, bySection, mailboxName, useThreads, type MailPage } from "@/lib/mail.ts";
import { ThreadListSkeleton } from "./thread-list-skeleton.tsx";
import { ThreadRow } from "./thread-row.tsx";

export interface ThreadListProps {
  page: MailPage;
  /** One mailbox, or every inbox the person can open. */
  mailboxId: string | undefined;
  mailboxes: Mailbox[];
  you: string;
}

/**
 * A mail page's threads, newest first under a heading per day, older ones as you scroll, pull
 * to refresh. A tap opens the conversation; a long press peeks at it, with Done, Later and Mark
 * unread in its menu.
 */
export function ThreadList({ page, mailboxId, mailboxes, you }: ThreadListProps) {
  const threads = useThreads(page, mailboxId);
  const done = useDone();
  const later = useLater();
  const unread = useMarkUnread();
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
  return (
    <InfiniteList
      query={threads}
      rows={sections}
      keyOf={(row) => row.id}
      typeOf={(row) => row.kind}
      icon={IconInbox}
      empty={MAIL_PAGES[page].empty}
      skeleton={<ThreadListSkeleton />}
      renderItem={(row) =>
        row.kind === "heading" ? (
          <SectionHeading label={row.label} />
        ) : (
          <Link href={{ pathname: "/mail/thread/[id]", params: { id: row.item.id, page } }} asChild>
            <Link.Trigger>
              <ThreadRow
                thread={{
                  ...row.item,
                  sender: row.item.latestFrom?.name || row.item.latestFrom?.address || "",
                  senderAddress: row.item.latestFrom?.address,
                }}
                sharedInbox={shared.get(row.item.mailboxId)}
              />
            </Link.Trigger>
            <Link.Preview />
            <Link.Menu>
              {triaged ? (
                <Link.MenuAction icon="checkmark.circle" onPress={() => done(row.item)}>
                  Done
                </Link.MenuAction>
              ) : null}
              {triaged ? (
                <Link.MenuAction icon="clock" onPress={() => later(row.item)}>
                  Later
                </Link.MenuAction>
              ) : null}
              {row.item.unread ? null : (
                <Link.MenuAction icon="envelope.badge" onPress={() => unread(row.item)}>
                  Mark unread
                </Link.MenuAction>
              )}
            </Link.Menu>
          </Link>
        )
      }
    />
  );
}

const sections = (threads: ThreadSummary[]) =>
  bySection(
    threads,
    (t) => t.id,
    (t) => t.lastMessageAt,
  );
