import { useRef } from "react";
import { SkeletonBox } from "skullet/react";
import { ConversationMeta, rowTime } from "@/components/inbox/conversation-meta";
import { SenderAvatar, byAddress } from "@/components/avatar/sender-avatar";
import { GridListHeader, GridListItem } from "@/components/ui/grid-list";
import type { ListRow } from "@/components/inbox/thread-list";
import { usePrefetchThread } from "@/hooks/use-mail.ts";

const HOVER_INTENT = 80;

function useHoverIntent(threadId: string) {
  const prefetch = usePrefetchThread();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return {
    start: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => prefetch(threadId), HOVER_INTENT);
    },
    end: () => clearTimeout(timer.current),
  };
}

export function ThreadRow({
  thread,
  href,
  isCurrent,
}: {
  thread: ListRow;
  href: string;
  isCurrent: boolean;
}) {
  const sender = thread.sender;
  const tone = thread.unread ? "text-foreground" : "text-muted-foreground";
  const hover = useHoverIntent(thread.id);
  return (
    <GridListItem
      id={thread.id}
      href={href}
      onHoverStart={hover.start}
      onHoverEnd={hover.end}
      textValue={`${sender} ${thread.subject}`}
      className={`mx-2.5 h-10 gap-3 rounded-lg px-3 selected:bg-primary-subtle **:data-[slot=indicator]:mix-blend-multiply ${isCurrent ? "bg-accent" : ""}`}
    >
      <span className="flex w-1.5 shrink-0 justify-center">
        {thread.unread && <span aria-label="Unread" className="size-1.5 rounded-full bg-primary" />}
      </span>
      <span className={`w-[min(--spacing(36),25%)] shrink-0 truncate ${tone}`}>{sender}</span>
      <SenderAvatar
        isSquare
        who={byAddress(thread.senderAddress)}
        name={sender}
        className="shrink-0 bg-accent text-foreground outline-0 mix-blend-multiply [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(5)]"
      />
      <span className="ms-3 flex w-[min(--spacing(64),30%)] shrink-0 items-center gap-2 @max-2xl:min-w-0 @max-2xl:flex-1">
        <span className={`min-w-0 flex-1 truncate ${tone}`}>
          {thread.subject || "(no subject)"}
        </span>
        {(thread.count ?? 0) > 1 && (
          <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
            {thread.count}
          </span>
        )}
      </span>
      <span className="ms-3 min-w-0 flex-1 truncate text-subtle-foreground @max-2xl:hidden">
        {thread.snippet}
      </span>
      {thread.conversation ? (
        <ConversationMeta info={thread.conversation} />
      ) : (
        thread.date && (
          <span className="w-14 shrink-0 text-end text-xs text-subtle-foreground tabular-nums">
            {rowTime(thread.date)}
          </span>
        )
      )}
    </GridListItem>
  );
}

/**
 * A date group's label and how many rows it holds. The hover highlight skips it. 48px, the room
 * above each group; the first is 36px, so it sits close under the list's title.
 */
export function DateHeader(props: { label: string; count: number; first: boolean }) {
  const { label, count } = props;
  return (
    <GridListHeader
      data-fluid-hover-skip
      className={`mx-2.5 flex items-end gap-1.5 ps-2.5 pe-3 pb-3 text-sm text-muted-foreground ${props.first ? "h-9" : "h-12"}`}
    >
      {label}
      <span className="text-subtle-foreground tabular-nums">{count}</span>
    </GridListHeader>
  );
}

/**
 * The list while its rows load, drawn from skullet's boxes on the row's own grid (checkbox,
 * dot, sender, avatar, subject, preview), enough rows to fill the list. Not measured from sample
 * rows: the skeleton is held back 150 ms and usually never shows, and measuring cost every switch.
 */
export function RowBones() {
  return (
    <div className="px-2.5 pt-2">
      {Array.from({ length: 20 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 ps-11 pe-3">
          <span className="w-[min(--spacing(36),25%)] shrink-0">
            <SkeletonBox width={`${45 + ((i * 17) % 30)}%`} height={10} />
          </span>
          <SkeletonBox width={20} height={20} radius="var(--radius-sm)" />
          <span className="ms-3 w-[min(--spacing(64),30%)] shrink-0">
            <SkeletonBox width={`${55 + ((i * 23) % 35)}%`} height={10} />
          </span>
          <span className="ms-3 min-w-0 flex-1">
            <SkeletonBox width={`${50 + ((i * 13) % 40)}%`} height={10} />
          </span>
        </div>
      ))}
    </div>
  );
}
