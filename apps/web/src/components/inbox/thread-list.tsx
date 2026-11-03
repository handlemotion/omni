import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Selection } from "react-aria-components";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { Heading } from "@/components/ui/heading";
import { useCounts, useThreads } from "@/hooks/use-mail.ts";
import type { ThreadFilter, ThreadSummary } from "@/lib/types.ts";

// Figma: Omni, inbox list (node 15:2), on our tokens: brand blue for the count, checkboxes and
// unread dot; foreground for unread text, muted for read, subtle for previews.
export function ThreadList(props: {
  title: string;
  filter: ThreadFilter;
  /** Where a row opens. */
  href: (threadId: string) => string;
  /** The open thread, beside the list. */
  children?: ReactNode;
}) {
  const { threads, hasNextPage, fetchNextPage, isFetchingNextPage } = useThreads(props.filter);
  const unread = useUnreadCount(props.filter);
  const [selected, setSelected] = useState<Selection>(new Set());
  const count = selected === "all" ? threads.length : selected.size;

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center px-5">
          <Heading>
            {props.title}
            {unread > 0 && <span className="ms-1 text-primary tabular-nums">{unread}</span>}
          </Heading>
        </header>

        <div className="flex h-10.5 items-center gap-2 border-b px-5">
          <CheckboxField
            aria-label="Select all"
            isSelected={threads.length > 0 && count === threads.length}
            isIndeterminate={count > 0 && count < threads.length}
            onChange={(all) => setSelected(all ? "all" : new Set())}
          >
            <Checkbox />
          </CheckboxField>
          <span className="text-xs text-subtle-foreground">Most recent</span>
        </div>

        <GridList
          aria-label={props.title}
          items={threads}
          selectionMode="multiple"
          selectionBehavior="toggle"
          selectedKeys={selected}
          onSelectionChange={setSelected}
        >
          {(thread) => <ThreadRow thread={thread} href={props.href(thread.id)} />}
        </GridList>

        {hasNextPage && (
          <LoadMore onVisible={() => void fetchNextPage()} isLoading={isFetchingNextPage} />
        )}
      </section>
      {props.children}
    </div>
  );
}

function ThreadRow({ thread, href }: { thread: ThreadSummary; href: string }) {
  const sender = senderLabel(thread);
  return (
    <GridListItem
      id={thread.id}
      href={href}
      textValue={`${sender} ${thread.subject}`}
      className="gap-4 border-b px-5 py-3"
    >
      <Avatar
        isSquare
        initials={sender.slice(0, 1).toUpperCase()}
        className="shrink-0 bg-accent text-foreground outline-0 [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(7)]"
      />
      {/* 16px gap plus 16px margin: the frame's 32px between avatar and sender. */}
      <span
        className={`ms-4 w-68 shrink-0 truncate ${thread.unread ? "text-foreground" : "text-muted-foreground"}`}
      >
        {sender}
      </span>
      <span className="relative flex min-w-0 flex-1 items-center">
        {thread.unread && (
          <span
            aria-label="Unread"
            className="absolute -left-4.25 size-2 rounded-full bg-primary"
          />
        )}
        <span className="truncate">
          <span className={thread.unread ? "text-foreground" : "text-muted-foreground"}>
            {thread.subject || "(no subject)"} –
          </span>{" "}
          <span className="ms-1.5 text-subtle-foreground">{thread.snippet}</span>
        </span>
      </span>
    </GridListItem>
  );
}

/** One sender: their name. Several: first names, in the order they wrote. */
function senderLabel(thread: ThreadSummary) {
  const people = thread.participants.length
    ? thread.participants
    : thread.latestFrom
      ? [thread.latestFrom]
      : [];
  if (people.length === 1) return people[0]?.name || people[0]?.address || "";
  return people.map((p) => p.name?.split(" ")[0] || p.address.split("@")[0]).join(", ");
}

/** Unread threads in the inbox (or one lane of it), across the filtered mailbox(es). */
function useUnreadCount(filter: ThreadFilter) {
  const { data } = useCounts();
  if (filter.view !== "inbox" || filter.lane || !data) return 0;
  return data.counts
    .filter((c) => !filter.mailbox || c.mailboxId === filter.mailbox)
    .reduce((sum, c) => sum + c.unread, 0);
}

/** Loads the next page when it scrolls into view. */
function LoadMore(props: { onVisible: () => void; isLoading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onVisible, isLoading } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el || isLoading) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && onVisible());
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible, isLoading]);
  return <div ref={ref} className="h-px" />;
}
