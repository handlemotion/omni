import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { useParams } from "@tanstack/react-router";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import type { Selection } from "react-aria-components";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { ListLayout, Virtualizer } from "react-aria-components/Virtualizer";
import { ConversationMeta, type ConversationRowInfo } from "@/components/inbox/conversation-meta";
import { ListSweepSlot } from "@/components/inbox/list-sweep";
import { SearchPopover } from "@/components/search/search-popover";
import { buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { Heading } from "@/components/ui/heading";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useCounts, useThreads } from "@/hooks/use-mail.ts";
import { useThreadListShortcuts } from "@/hooks/use-thread-list-shortcuts.ts";
import { useWorkspaceNames } from "@/hooks/use-workspaces.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";
import { senderLabel } from "@/lib/threads.ts";
import type {
  ConversationFilter,
  ConversationSummary,
  ThreadFilter,
  ThreadSummary,
  ThreadView,
} from "@/lib/types.ts";

// The list beside an open thread: wide enough for a sender, subject and preview line.
const LIST_WIDTH = 440;
const LIST_MIN = 320;
const LIST_MAX = 720;

/** What a list row shows. Threads and search results both map to it. */
export interface ListRow {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  unread: boolean;
  /** The workspace it belongs to, when the list spans more than one. */
  workspace?: string | undefined;
  /** A helpdesk conversation's status, assignee, SLA and the rest, shown after the subject. */
  conversation?: ConversationRowInfo | undefined;
}

interface ListProps {
  title: string;
  /** Where a row opens. */
  href: (threadId: string) => string;
  /** The open thread, beside the list. */
  children?: ReactNode;
}

/** One view's threads (inbox, queue, all mail...), loading more as it scrolls. */
export function ThreadList(props: ListProps & { filter: ThreadFilter }) {
  const { threads, hasNextPage, fetchNextPage, isFetchingNextPage } = useThreads(props.filter);
  const unread = useUnreadCount(props.filter);
  const names = useWorkspaceNames(props.filter.mailbox);
  // Stable rows, so the virtualized list's row cache survives renders that don't change them.
  const rows = useMemo(
    () => threads.map((thread) => toRow(thread, names?.get(thread.orgId))),
    [threads, names],
  );
  // Stable too: a new function would re-render every row (see `Rows`).
  const loadMore = useMemo(
    () => (hasNextPage ? () => void fetchNextPage() : undefined),
    [hasNextPage, fetchNextPage],
  );
  return (
    <List
      {...props}
      rows={rows}
      count={unread}
      shortcuts={{ view: props.filter.view, threads, loadMore }}
      loadMore={loadMore}
      isLoadingMore={isFetchingNextPage}
    />
  );
}

const toRow = (thread: ThreadSummary, workspace?: string): ListRow => ({
  id: thread.id,
  sender: senderLabel(thread),
  subject: thread.subject,
  snippet: thread.snippet,
  unread: thread.unread,
  workspace,
});

// Figma: Omni, inbox list (node 15:2), on our tokens: brand blue for the count, checkboxes and
// unread dot; foreground for unread text, muted for read, subtle for previews.
export function List(
  props: ListProps & {
    rows: ListRow[];
    /** Shown in brand blue after the title (unread threads), when above zero. */
    count?: number;
    /** What the bar above the rows says about their order or scope. */
    caption?: ReactNode;
    /** Loads the next page, called as the end of the list nears. */
    loadMore?: (() => void) | undefined;
    isLoadingMore?: boolean;
    /** The list keys (j/k, x, e, ...), for lists of threads. */
    shortcuts?: ShortcutsSource;
    /** Shown in place of the caption while rows are selected: what to do with them. */
    bulkActions?: (selection: { ids: string[]; clear: () => void }) => ReactNode;
    /** Shown in place of the rows when there are none (or they failed to load). */
    empty?: ReactNode;
  },
) {
  const threads = props.rows;
  const unread = props.count ?? 0;
  const [selected, setSelected] = useState<Selection>(new Set());
  const count = selected === "all" ? threads.length : selected.size;
  const [fullScreen] = useFullScreen();
  const { threadId } = useParams({ strict: false });
  // Full screen (toggled from the conversation's toolbar): an open thread takes the whole width.
  const hideList = fullScreen && !!threadId;
  const listRef = useRef<HTMLElement>(null);
  // Beside an open thread the list keeps a width the person can drag; alone it fills the page.
  const split = !!threadId && !hideList;
  const listWidth = useStoredWidth("omni:list-width", LIST_WIDTH, LIST_MIN, LIST_MAX);
  const [resizing, setResizing] = useState(false);

  return (
    // Viewport height, so the virtualized list is its own scroll container however tall the
    // thread beside it is. No `flex-1`: its 0% basis resolves to the content height here.
    <div className="flex h-svh min-h-0 flex-col">
      {props.shortcuts && (
        <ListShortcuts
          {...props.shortcuts}
          threadId={threadId}
          href={props.href}
          selected={selected}
          setSelected={setSelected}
          listRef={listRef}
          listHidden={hideList}
        />
      )}
      {/* 10px on the right, the same as the 28px controls' inset from the top. */}
      <header className="flex h-12 shrink-0 items-center gap-2 ps-5 pe-2.5">
        {/* 1px down: centers the title's capitals on the sidebar header's icons. */}
        <Heading className="translate-y-px">
          {props.title}
          {unread > 0 && <span className="ms-1 text-primary tabular-nums">{unread}</span>}
        </Heading>
        <div className="ms-auto flex items-center gap-2">
          <SearchPopover />
          <Link
            href="/compose"
            aria-keyshortcuts={ariaKeyShortcuts("compose")}
            className={buttonStyles({ intent: "primary", size: "sm" })}
          >
            <PencilSquareIcon />
            Compose
          </Link>
        </div>
      </header>

      <div className={`flex min-h-0 flex-1 ${resizing ? "cursor-ew-resize select-none" : ""}`}>
        <section
          ref={listRef}
          style={split ? { width: listWidth.width } : undefined}
          className={`flex min-w-0 flex-col ${split ? "flex-none" : "flex-1"} ${hideList ? "hidden" : ""}`}
        >
          {/* pb-0.5 lifts the row 1px: under the borderless header the true middle reads low.
              The reader's toolbar beside it does the same, so the two stay on one line. */}
          <div className="flex h-10.5 items-center gap-2 border-b px-5 pb-0.5">
            <CheckboxField
              aria-label="Select all"
              isSelected={threads.length > 0 && count === threads.length}
              isIndeterminate={count > 0 && count < threads.length}
              onChange={(all) => setSelected(all ? "all" : new Set())}
            >
              <Checkbox />
            </CheckboxField>
            {count > 0 && props.bulkActions ? (
              props.bulkActions({
                ids: selected === "all" ? threads.map((t) => t.id) : [...selected].map(String),
                clear: () => setSelected(new Set()),
              })
            ) : (
              // 1px down: the caption's ink centers on the checkbox's, not its line box.
              <span className="translate-y-px text-xs text-subtle-foreground">
                {props.caption ?? "Most recent"}
              </span>
            )}
          </div>

          {/* Only the rows on screen are in the DOM, so thousands of threads scroll like fifty.
              The list is its own scroll container; rows keep the frame's fixed height. The
              wrapper holds the fluid hover highlight, which sits under the rows and follows the
              list's scroll. The slot puts them inside smart search's sweep. */}
          {props.empty && !threads.length ? (
            props.empty
          ) : (
            <ListSweepSlot>
              <RowHover>
                <Rows
                  label={props.title}
                  rows={threads}
                  href={props.href}
                  selected={selected}
                  onSelectionChange={setSelected}
                  loadMore={props.loadMore}
                  isLoadingMore={props.isLoadingMore}
                />
              </RowHover>
            </ListSweepSlot>
          )}
        </section>
        {/* Always the same wrapper, so full screen doesn't remount the thread (or its scroll). */}
        {props.children && (
          <div className="relative flex min-w-0 flex-1">
            {split && (
              <ResizeGrip
                label="Resize list"
                width={() => listWidth.width}
                onResize={listWidth.set}
                onReset={listWidth.reset}
                onResizingChange={setResizing}
              />
            )}
            {props.children}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The virtualized rows, memoized: `List` re-renders when a thread opens (the URL), the selection
 * count changes or the hover highlight moves, and any re-render of the grid re-renders every
 * visible row (React Aria hands each row fresh context). With stable props the rows render only
 * when what they show changes.
 */
const Rows = memo(function Rows(props: {
  label: string;
  rows: ListRow[];
  href: (threadId: string) => string;
  selected: Selection;
  onSelectionChange: (keys: Selection) => void;
  loadMore?: (() => void) | undefined;
  isLoadingMore?: boolean | undefined;
}) {
  return (
    <Virtualizer layout={ListLayout} layoutOptions={LIST_LAYOUT}>
      <GridList
        aria-label={props.label}
        // Transparent: the list is positioned, so its own fill would paint over the
        // highlight. The page behind it is already the background.
        className="min-h-0 flex-1 overflow-y-auto bg-transparent"
        // Letters are shortcuts here (j, k, x, e, ...), not type-to-find.
        disallowTypeAhead
        selectionMode="multiple"
        selectionBehavior="toggle"
        selectedKeys={props.selected}
        onSelectionChange={props.onSelectionChange}
      >
        {/* `items` lets React Aria cache rows by thread, so a scroll renders only new rows. */}
        <Collection items={props.rows} dependencies={[props.href]}>
          {(thread) => <ThreadRow thread={thread} href={props.href(thread.id)} />}
        </Collection>
        {/* Asks for the next page as the end of the list nears. */}
        <GridListLoadMoreItem onLoadMore={props.loadMore} isLoading={props.isLoadingMore} />
      </GridList>
    </Virtualizer>
  );
});

/**
 * One hover highlight springs between the rows (transitive's fluid hover). The row moved to with
 * j/k lights the same way whenever the pointer is not over the list. Its own component, taking
 * the rows as `children`: the highlight moves on every scroll (the rows move under the pointer),
 * and re-rendering here leaves the rows alone, where re-rendering `List` re-rendered every row.
 */
function RowHover({ children }: { children: ReactNode }) {
  const hover = useFluidHoverList({
    itemSelector: "[role='row']",
    highlightedSelector: "[data-focus-visible]",
  });
  return (
    <div className="@container relative flex min-h-0 flex-1 flex-col" {...hover.containerProps}>
      <FluidHoverHighlight {...hover.highlightProps} />
      {children}
    </div>
  );
}

// 53px: the frame's row (12px padding, the 28px avatar, 12px padding, 1px border). The load-more
// sentinel takes no space; `loaderSize` 0 keeps the list's end where it was.
const LIST_LAYOUT = { rowSize: 53, loaderSize: 0 };

interface ShortcutsSource {
  view: ThreadView;
  threads: ThreadSummary[];
  loadMore?: (() => void) | undefined;
  /** A helpdesk list: e, h and i resolve, snooze and assign instead of done and defer. */
  helpdesk?: { filter: ConversationFilter; conversations: ConversationSummary[] } | undefined;
}

/** Binds the list keys while mounted; a component so `List` can use them only for threads. */
function ListShortcuts(props: Parameters<typeof useThreadListShortcuts>[0]) {
  useThreadListShortcuts(props);
  return null;
}

function ThreadRow({ thread, href }: { thread: ListRow; href: string }) {
  const sender = thread.sender;
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
      {/* 16px gap plus 16px margin: the frame's 32px between avatar and sender. The sender
          column narrows with the list beside an open thread, so the subject keeps room. */}
      <span
        className={`ms-4 w-[min(--spacing(68),30%)] shrink-0 truncate ${thread.unread ? "text-foreground" : "text-muted-foreground"}`}
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
            {thread.subject || "(no subject)"}
            {thread.snippet && " –"}
          </span>
          {thread.snippet && (
            <span className="ms-1.5 text-subtle-foreground">{thread.snippet}</span>
          )}
        </span>
      </span>
      {thread.workspace && (
        <span className="max-w-40 shrink-0 truncate text-xs text-subtle-foreground">
          {thread.workspace}
        </span>
      )}
      {thread.conversation && <ConversationMeta info={thread.conversation} />}
    </GridListItem>
  );
}

/** Unread threads in the inbox (or one lane of it), across the filtered mailbox(es). */
function useUnreadCount(filter: ThreadFilter) {
  const { data } = useCounts();
  if (filter.view !== "inbox" || filter.lane || !data) return 0;
  return data.counts
    .filter((c) => !filter.mailbox || c.mailboxId === filter.mailbox)
    .reduce((sum, c) => sum + c.unread, 0);
}
