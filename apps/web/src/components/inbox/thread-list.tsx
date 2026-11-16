import { useLocation, useParams } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Selection } from "react-aria-components";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { ListLayout, Virtualizer } from "react-aria-components/Virtualizer";
import { Skeleton } from "skullet/react";
import type { ConversationRowInfo } from "@/components/inbox/conversation-meta";
import { DateHeader, RowBones, ThreadRow } from "@/components/inbox/thread-row";
import { ListSweepSlot } from "@/components/inbox/list-sweep";
import { OpenListContext } from "@/components/inbox/open-list";
import { HeaderAction, MarkAllRead, ReloadAction } from "@/components/inbox/list-header-actions";
import { RowMenu } from "@/components/inbox/row-menu";
import { EmptyState } from "@/components/empty/empty-state";
import { ThreadListEmpty } from "@/components/inbox/list-empty";
import { FloatingCompose } from "@/components/compose/floating-actions";
import { IconPencil } from "@/components/icons/central";
import { IconSearch } from "@/components/icons/sidebar";
import { openSearch, SearchPopover } from "@/components/search/search-popover";
import { Button } from "@/components/ui/button";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";
import { GridList, GridListSection } from "@/components/ui/grid-list";
import { Heading } from "@/components/ui/heading";
import { useSidebar } from "@/components/ui/sidebar";
import { PageNav, usePageNavShown } from "@/components/shell/page-nav";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { useOpenCompose } from "@/hooks/use-compose-pane.ts";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useThreads } from "@/hooks/use-mail.ts";
import { useToday } from "@/hooks/use-today.ts";
import {
  useThreadListShortcuts,
  type ThreadListActions,
} from "@/hooks/use-thread-list-shortcuts.ts";
import { groupByDate } from "@/lib/date-groups.ts";
import { senderLabel } from "@/lib/threads.ts";
import type {
  ConversationFilter,
  ConversationSummary,
  ThreadFilter,
  ThreadSummary,
  ThreadView,
} from "@/lib/types.ts";

// With a thread open, the reading column keeps the width the person dragged it to (640px until
// then) and the list takes the rest, never under 320px (`min-w-80`). The width is the reader's,
// not the list's, so a wide window grows the list and the reader stays where it was put.
const READER_WIDTH = 640;
const READER_MIN = 400;
const READER_MAX = 4096;
const LIST_MIN = 320;

/** What a list row shows. Threads and search results both map to it. */
export interface ListRow {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  unread: boolean;
  /** When the thread last heard from anyone: the row's time and its date group. */
  date?: string | undefined;
  /** Messages in the thread, shown after the subject when there is more than one. */
  count?: number | undefined;
  /** A helpdesk conversation's status, assignee, SLA and the rest, shown after the subject. */
  conversation?: ConversationRowInfo | undefined;
  /** Your own Done and Later on the thread, where the row's menu offers them. */
  triage?: { done: boolean; later: boolean; lastMessageAt: string } | undefined;
}

interface ListProps {
  title: string;
  /** Where a row opens. */
  href: (threadId: string) => string;
  /** The open thread, beside the list. */
  children?: ReactNode;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
  /** Rows under relative date headers (Today, Yesterday, ...), from each row's `date`. */
  grouped?: boolean;
}

/** One view's threads (inbox, later, all mail...), loading more as it scrolls. */
export function ThreadList(props: ListProps & { filter: ThreadFilter }) {
  const {
    threads,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isPending,
    isError,
    isSuccess,
    refetch,
  } = useThreads(props.filter);
  // Stable rows, so the virtualized list's row cache survives renders that don't change them.
  const rows = useMemo(() => threads.map(toRow), [threads]);
  // Stable too: a new function would re-render every row (see `Rows`).
  const loadMore = useMemo(
    () => (hasNextPage ? () => void fetchNextPage() : undefined),
    [hasNextPage, fetchNextPage],
  );
  return (
    <List
      grouped
      {...props}
      empty={
        props.empty ??
        (isError ? (
          <ListFailed retry={() => void refetch()} />
        ) : isSuccess ? (
          <ThreadListEmpty filter={props.filter} />
        ) : undefined)
      }
      rows={rows}
      loading={isPending}
      shortcuts={{ view: props.filter.view, threads, loadMore }}
      loadMore={loadMore}
      isLoadingMore={isFetchingNextPage}
    />
  );
}

/** A list that failed to load, with the way to try again. */
export function ListFailed(props: { retry: () => void }) {
  return (
    <EmptyState figure="plug" title="This list didn't load">
      <Button size="sm" intent="outline" onPress={props.retry}>
        Try again
      </Button>
    </EmptyState>
  );
}

const toRow = (thread: ThreadSummary): ListRow => ({
  id: thread.id,
  sender: senderLabel(thread),
  subject: thread.subject,
  snippet: thread.snippet,
  unread: thread.unread,
  date: thread.lastMessageAt,
  count: thread.messageCount,
  triage: { done: thread.done, later: thread.later, lastMessageAt: thread.lastMessageAt },
});

// Figma: Omni, inbox list (node 15:2), on our tokens: brand blue for the count, checkboxes and
// unread dot; foreground for unread text, muted for read, subtle for previews.
export function List(
  props: ListProps & {
    rows: ListRow[];
    /**
     * The rows are on their way: a skeleton stands in. Screens open before their data (route
     * loaders don't wait), and skullet holds the skeleton back 150 ms, so a quick load never
     * shows it.
     */
    loading?: boolean;
    /** What the header says about the rows' order or scope, after the title. */
    caption?: ReactNode;
    /** Loads the next page, called as the end of the list nears. */
    loadMore?: (() => void) | undefined;
    isLoadingMore?: boolean;
    /** The list keys (j/k, x, e, ...), for lists of threads. */
    shortcuts?: ShortcutsSource;
    /** Shown in the header while rows are selected: what to do with them. */
    bulkActions?: (selection: { ids: string[]; clear: () => void }) => ReactNode;
    /** Shown in place of the rows when there are none (or they failed to load). */
    empty?: ReactNode;
    /** Rows that are not threads (drafts) have no context menu. */
    rowMenu?: boolean;
  },
) {
  const pageNav = usePageNavShown();
  const threads = props.rows;
  const [selected, setSelected] = useState<Selection>(new Set());
  const count = selected === "all" ? threads.length : selected.size;
  const [fullScreen] = useFullScreen();
  const { threadId } = useParams({ strict: false });
  // The list without the open thread: its row links here, so clicking it again closes it.
  const location = useLocation();
  const closeHref = threadId
    ? location.pathname.slice(0, location.pathname.lastIndexOf("/")) + location.searchStr
    : undefined;
  // New mail opens in a dialog over the page (`ComposeDialog`).
  const openCompose = useOpenCompose();
  const detail = !!threadId;
  // Full screen (toggled from the conversation's toolbar): the open pane takes the whole width.
  const hideList = fullScreen && detail;
  const listRef = useRef<HTMLElement>(null);
  // The keys' actions, for the rows' context menu.
  const actions = useRef<ThreadListActions | null>(null);
  // With a thread open, three columns: the list keeps a width the person can drag, the reading
  // column the rest at the window's full height. Closed, the list fills the page.
  const split = detail && !hideList;
  const reader = useStoredWidth("omni:reader-width", READER_WIDTH, READER_MIN, READER_MAX);
  const rowRef = useRef<HTMLDivElement>(null);
  // The grip moves the edge between the list and the reader: it reports the list's new width,
  // and the reader takes what the row leaves, so the list never drops under its minimum.
  const resizeList = (listWidth: number) => {
    const row = rowRef.current?.offsetWidth ?? 0;
    reader.set(row - Math.max(LIST_MIN, listWidth));
  };
  const [resizing, setResizing] = useState(false);
  // The rows behind the open thread, for its full-screen switcher.
  // A helpdesk list's rows follow its status, not Done or Later: no view to leave there.
  const view = props.shortcuts?.helpdesk ? undefined : props.shortcuts?.view;
  const openList = useMemo(
    () => ({ rows: threads, href: props.href, closeHref, view }),
    [threads, props.href, closeHref, view],
  );
  const sidebar = useSidebar();

  const rows = (
    <RowHover>
      <Rows
        label={props.title}
        rows={threads}
        grouped={props.grouped}
        href={props.href}
        current={threadId}
        closeHref={closeHref}
        selected={selected}
        onSelectionChange={setSelected}
        loadMore={props.loadMore}
        isLoadingMore={props.isLoadingMore}
      />
    </RowHover>
  );

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
          actions={actions}
        />
      )}
      {/* The list and the reading column side by side, each the window's full height. */}
      <div
        ref={rowRef}
        className={`flex min-h-0 flex-1 ${resizing ? "cursor-ew-resize select-none" : ""}`}
      >
        <section
          ref={listRef}
          className={`relative flex flex-1 flex-col ${split ? "min-w-80" : "min-w-0"} ${hideList ? "hidden" : ""}`}
        >
          {/* 10px each side, the same as the 28px controls' inset from the top; 20px before a
              title that starts the header, as the reading column's subject has. */}
          <header
            className={`flex h-12 shrink-0 items-center gap-2 pe-2.5 ${pageNav ? "ps-2.5" : "ps-5"}`}
          >
            <PageNav />
            {/* 14px. Centred as laid out, with no nudge: its capitals sit on the icons' centre
                line. It never shrinks: the caption truncates and the search field narrows
                first. */}
            <Heading className="shrink-0 text-md whitespace-nowrap">{props.title}</Heading>
            <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
              {props.caption}
            </span>
            {/* A plain list's checked rows: how many, before the actions. */}
            {count > 0 && !props.bulkActions && (
              <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                {count} selected
              </span>
            )}
            <div className="flex min-w-0 items-center gap-1 *:shrink-0 *:data-[search-field]:shrink">
              {/* The same search as the sidebar's field (and `/`). On a phone the sidebar is a sheet
                  that unmounts when closed, so the header holds the search field itself there. */}
              {sidebar.isMobile ? (
                <SearchPopover />
              ) : (
                <HeaderAction label="Search" onPress={openSearch}>
                  <IconSearch />
                </HeaderAction>
              )}
              <MarkAllRead rows={threads} />
              <ReloadAction />
              {/* With no thread open, Compose floats at the list's foot instead. */}
              {detail && (
                <HeaderAction label="Compose" shortcut="compose" onPress={openCompose}>
                  <IconPencil />
                </HeaderAction>
              )}
            </div>
          </header>

          {/* Only the rows on screen are in the DOM, so thousands of threads scroll like fifty.
              The list is its own scroll container; rows keep the frame's fixed height. The
              wrapper holds the fluid hover highlight, which sits under the rows and follows the
              list's scroll. The slot puts them inside smart search's sweep. */}
          {props.loading ? (
            <Skeleton
              loading
              label={`Loading ${props.title}`}
              skeleton={<RowBones />}
              className="min-h-0 flex-1 overflow-hidden"
            >
              {null}
            </Skeleton>
          ) : props.empty && !threads.length ? (
            props.empty
          ) : (
            <ListSweepSlot>
              {props.rowMenu === false ? (
                rows
              ) : (
                <RowMenu
                  rows={threads}
                  href={props.href}
                  actions={actions}
                  inTrash={props.shortcuts?.view === "trash"}
                >
                  {rows}
                </RowMenu>
              )}
            </ListSweepSlot>
          )}
          {/* A helpdesk list's actions on its checked rows float at the column's foot, 16px up and
              centred, framed like the reader's properties bar. 12px before the count, where the
              buttons' labels sit from the other edge. */}
          {/* New mail, where Reply floats once a thread opens; gone while the bulk bar is up. */}
          {!detail && !(count > 0 && props.bulkActions) && (
            <FloatingCompose onPress={openCompose} />
          )}
          {count > 0 && props.bulkActions && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-5">
              <div className="pointer-events-auto max-w-full overflow-x-auto rounded-lg border bg-background p-0.5 ps-3">
                {props.bulkActions({
                  ids: selected === "all" ? threads.map((t) => t.id) : [...selected].map(String),
                  clear: () => setSelected(new Set()),
                })}
              </div>
            </div>
          )}
        </section>
        {/* The reading column, from the window's top to its bottom, only with a thread open. The
            same wrapper in and out of full screen, so toggling it doesn't remount it. */}
        {threadId && props.children && (
          // Split, a fixed width that still gives way to the list's minimum in a narrow window.
          <div
            style={split ? { width: reader.width } : undefined}
            className={`relative flex min-w-0 ${split ? "shrink" : "flex-1"}`}
          >
            {split && (
              <ResizeGrip
                label="Resize list"
                width={() => listRef.current?.offsetWidth ?? 0}
                onResize={resizeList}
                onReset={reader.reset}
                onResizingChange={setResizing}
              />
            )}
            <OpenListContext value={openList}>{props.children}</OpenListContext>
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
  grouped?: boolean | undefined;
  href: (threadId: string) => string;
  /** The open thread, whose row is filled. */
  current: string | undefined;
  /** Where the open thread's row leads: back to the list alone. */
  closeHref: string | undefined;
  selected: Selection;
  onSelectionChange: (keys: Selection) => void;
  loadMore?: (() => void) | undefined;
  isLoadingMore?: boolean | undefined;
}) {
  // Regroups at midnight, and redraws the rows so their times turn into days.
  const today = useToday();
  const groups = useMemo(
    () => (props.grouped ? groupByDate(props.rows, (row) => row.date ?? "") : undefined),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `today` moves the groups on.
    [props.grouped, props.rows, today],
  );
  const row = (thread: ListRow) => (
    <ThreadRow
      thread={thread}
      href={
        thread.id === props.current && props.closeHref ? props.closeHref : props.href(thread.id)
      }
      isCurrent={thread.id === props.current}
    />
  );
  const dependencies = [props.href, props.current, props.closeHref, today];
  return (
    <Virtualizer layout={ListLayout} layoutOptions={LIST_LAYOUT}>
      <GridList
        aria-label={props.label}
        // Transparent: the list is positioned, so its own fill would paint over the
        // highlight. The page behind it is already the background.
        // The virtualizer gives its sizer and row wrappers no width here (its measured width is
        // NaN), so each row would shrink to its content; they take the list's width instead.
        className="min-h-0 flex-1 overflow-y-auto overscroll-none bg-transparent *:w-full *:*:w-full"
        // Letters are shortcuts here (j, k, x, e, ...), not type-to-find.
        disallowTypeAhead
        selectionMode="multiple"
        selectionBehavior="toggle"
        selectedKeys={props.selected}
        onSelectionChange={props.onSelectionChange}
      >
        {/* `items` lets React Aria cache rows by thread, so a scroll renders only new rows. */}
        {groups ? (
          <Collection items={groups} dependencies={dependencies}>
            {(group) => (
              <GridListSection id={group.id} aria-label={group.label} className="divide-y-0">
                <DateHeader
                  label={group.label}
                  count={group.rows.length}
                  first={group === groups[0]}
                />
                <Collection items={group.rows} dependencies={dependencies}>
                  {row}
                </Collection>
              </GridListSection>
            )}
          </Collection>
        ) : (
          <Collection items={props.rows} dependencies={dependencies}>
            {row}
          </Collection>
        )}
        {/* Asks for the next page three screens before the end (React Aria's default is one),
            so older mail is usually there by the time the reader scrolls to it. */}
        <GridListLoadMoreItem
          onLoadMore={props.loadMore}
          isLoading={props.isLoadingMore}
          scrollOffset={3}
        />
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

// 40px rows (the row's own `h-10` must match) under date headers, measured: the first is shorter
// than the rest (`DateHeader`). The load-more sentinel takes no space; `loaderSize` 0 keeps the
// list's end where it was.
const LIST_LAYOUT = { rowSize: 40, estimatedHeadingSize: 48, loaderSize: 0 };

interface ShortcutsSource {
  view: ThreadView;
  threads: ThreadSummary[];
  loadMore?: (() => void) | undefined;
  /** A helpdesk list: e, h and i resolve, snooze and assign instead of done and defer. */
  helpdesk?: { filter: ConversationFilter; conversations: ConversationSummary[] } | undefined;
}

/** Binds the list keys while mounted; a component so `List` can use them only for threads. */
function ListShortcuts({
  actions,
  ...props
}: Parameters<typeof useThreadListShortcuts>[0] & {
  /** Handed the list's actions, for the rows' context menu. */
  actions: RefObject<ThreadListActions | null>;
}) {
  const current = useThreadListShortcuts(props);
  useEffect(() => {
    actions.current = current;
    return () => {
      actions.current = null;
    };
  });
  return null;
}
