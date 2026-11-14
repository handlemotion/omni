import { useLocation, useParams } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Selection } from "react-aria-components";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { ListLayout, Virtualizer } from "react-aria-components/Virtualizer";
import { Skeleton, SkeletonBox } from "skullet/react";
import { ConversationMeta, type ConversationRowInfo } from "@/components/inbox/conversation-meta";
import { ListSweepSlot } from "@/components/inbox/list-sweep";
import { OpenListContext } from "@/components/inbox/open-list";
import { SearchPopover } from "@/components/search/search-popover";
import { ComposePane } from "@/components/compose/compose-pane";
import { EmptyState } from "@/components/empty/empty-state";
import { IconPencil } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { Heading } from "@/components/ui/heading";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { IconSidebar } from "@/components/icons/sidebar";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { closeComposePane, useComposePane, useOpenCompose } from "@/hooks/use-compose-pane.ts";
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
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
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
      empty={
        props.empty ??
        (isError ? (
          <ListFailed retry={() => void refetch()} />
        ) : isSuccess ? (
          <EmptyState
            figure={props.filter.view === "archive" ? "cabinet" : "drawer"}
            title={emptyTitle(props.filter)}
          />
        ) : undefined)
      }
      rows={rows}
      loading={isPending}
      count={unread}
      shortcuts={{ view: props.filter.view, threads, loadMore }}
      loadMore={loadMore}
      isLoadingMore={isFetchingNextPage}
    />
  );
}

/** What an empty list is called: by its lane in the Inbox, else by its view. */
function emptyTitle(filter: ThreadFilter) {
  if (filter.view === "inbox" && filter.lane === "needs_reply") return "Nothing needs a reply";
  if (filter.view === "inbox" && filter.lane === "waiting_on_them") return "Not waiting on anyone";
  return EMPTY_TITLES[filter.view ?? "inbox"];
}

const EMPTY_TITLES: Record<ThreadView, string> = {
  inbox: "Inbox zero",
  later: "Nothing for later",
  done: "Nothing done yet",
  archive: "Nothing archived",
  all: "No mail yet",
};

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
    /**
     * The rows are on their way: a skeleton stands in. Screens open before their data (route
     * loaders don't wait), and skullet holds the skeleton back 150 ms, so a quick load never
     * shows it.
     */
    loading?: boolean;
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
  // The list without the open thread: its row links here, so clicking it again closes it.
  const location = useLocation();
  const closeHref = threadId
    ? location.pathname.slice(0, location.pathname.lastIndexOf("/")) + location.searchStr
    : undefined;
  // New mail opens in the reading pane, like a thread; a thread opening takes its place.
  const [composing, closeCompose] = useComposePane();
  const openCompose = useOpenCompose();
  useEffect(() => {
    if (threadId) closeComposePane();
  }, [threadId]);
  const detail = !!threadId || composing;
  // Full screen (toggled from the conversation's toolbar): the open pane takes the whole width.
  const hideList = fullScreen && detail;
  const listRef = useRef<HTMLElement>(null);
  // Beside an open thread the list keeps a width the person can drag; alone it fills the page.
  const split = detail && !hideList;
  const listWidth = useStoredWidth("omni:list-width", LIST_WIDTH, LIST_MIN, LIST_MAX);
  // Until dragged, the thread takes a 672px reading pane (`w-2xl`) and the list the rest, down to
  // its minimum.
  const hug = split && !listWidth.isSet;
  const [resizing, setResizing] = useState(false);
  // The rows behind the open thread, for its full-screen switcher.
  // A helpdesk list's rows follow its status, not Done or Later: no view to leave there.
  const view = props.shortcuts?.helpdesk ? undefined : props.shortcuts?.view;
  const openList = useMemo(
    () => ({ rows: threads, href: props.href, closeHref, view }),
    [threads, props.href, closeHref, view],
  );
  // Collapsed, the sidebar's own toggle is gone with it: the list's header offers it instead.
  const sidebar = useSidebar();
  const sidebarHidden = sidebar.isMobile || !sidebar.open;

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
      <header
        className={`flex h-12 shrink-0 items-center gap-2 pe-2.5 ${sidebarHidden ? "ps-2.5" : "ps-5"}`}
      >
        {sidebarHidden && (
          <SidebarTrigger intent="ghost" size="sq-xs" aria-label="Open sidebar">
            <IconSidebar />
          </SidebarTrigger>
        )}
        {/* 1px down: centers the title's capitals on the sidebar header's icons. Collapsed, the
            title centres on the sidebar button beside it instead, so it stays put. */}
        <Heading className={sidebarHidden ? "" : "translate-y-px"}>
          {props.title}
          {unread > 0 && <span className="ms-1 text-primary tabular-nums">{unread}</span>}
        </Heading>
        <div className="ms-auto flex items-center gap-2">
          <SearchPopover />
          <Button
            intent="primary"
            size="sm"
            aria-keyshortcuts={ariaKeyShortcuts("compose")}
            // 27px: a filled button reads 1px taller than the outlined search field beside it.
            className="h-6.75"
            onPress={openCompose}
          >
            <IconPencil />
            Compose
          </Button>
        </div>
      </header>

      <div className={`flex min-h-0 flex-1 ${resizing ? "cursor-ew-resize select-none" : ""}`}>
        <section
          ref={listRef}
          style={split && !hug ? { width: listWidth.width } : undefined}
          className={`flex flex-col ${hug ? "min-w-80" : "min-w-0"} ${split && !hug ? "flex-none" : "flex-1"} ${hideList ? "hidden" : ""}`}
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
              <RowHover>
                <Rows
                  label={props.title}
                  rows={threads}
                  href={props.href}
                  current={threadId}
                  closeHref={closeHref}
                  selected={selected}
                  onSelectionChange={setSelected}
                  loadMore={props.loadMore}
                  isLoadingMore={props.isLoadingMore}
                />
              </RowHover>
            </ListSweepSlot>
          )}
        </section>
        {/* Only with a thread (or new mail) open: closed, the list takes the full width. The same
            wrapper in and out of full screen, so toggling it doesn't remount the thread. */}
        {detail && (props.children || composing) && (
          <div className={`relative flex min-w-0 ${hug ? "w-2xl shrink" : "flex-1"}`}>
            {split && (
              <ResizeGrip
                label="Resize list"
                width={() => listRef.current?.offsetWidth ?? listWidth.width}
                onResize={listWidth.set}
                onReset={listWidth.reset}
                onResizingChange={setResizing}
              />
            )}
            {threadId ? (
              <OpenListContext value={openList}>{props.children}</OpenListContext>
            ) : (
              <ComposePane onClose={closeCompose} />
            )}
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
  /** The open thread, whose row is filled. */
  current: string | undefined;
  /** Where the open thread's row leads: back to the list alone. */
  closeHref: string | undefined;
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
        <Collection items={props.rows} dependencies={[props.href, props.current, props.closeHref]}>
          {(thread) => (
            <ThreadRow
              thread={thread}
              href={
                thread.id === props.current && props.closeHref
                  ? props.closeHref
                  : props.href(thread.id)
              }
              isCurrent={thread.id === props.current}
            />
          )}
        </Collection>
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

function ThreadRow({
  thread,
  href,
  isCurrent,
}: {
  thread: ListRow;
  href: string;
  isCurrent: boolean;
}) {
  const sender = thread.sender;
  return (
    <GridListItem
      id={thread.id}
      href={href}
      textValue={`${sender} ${thread.subject}`}
      // The open thread's row keeps the accent fill, the same grey as the sidebar's current item;
      // a checked row takes the brand tint, like your own messages. The checkbox and the avatar
      // multiply, so their edge and fill still show on the hover highlight or the tint.
      className={`gap-4 border-b px-5 py-3 selected:bg-primary-subtle **:data-[slot=indicator]:mix-blend-multiply ${isCurrent ? "bg-accent" : ""}`}
    >
      <Avatar
        isSquare
        initials={sender.slice(0, 1).toUpperCase()}
        className="shrink-0 bg-accent text-foreground outline-0 mix-blend-multiply [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(7)]"
      />
      {/* 16px gap plus 16px margin: the frame's 32px between avatar and sender. The sender
          column narrows with the list beside an open thread, so the subject keeps room and
          sits close to the name. */}
      <span
        className={`ms-4 w-[min(--spacing(68),30%)] shrink-0 truncate @max-4xl:w-[min(--spacing(36),25%)] ${thread.unread ? "text-foreground" : "text-muted-foreground"}`}
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

/**
 * The list while its rows load, drawn from skullet's boxes on the row's own grid (avatar,
 * sender, subject; the checkbox column stays empty), enough rows to fill the list. Not measured
 * from sample rows: measuring ran on every list switch, a quarter of its time, though the
 * skeleton is held back 150 ms and usually never shows. Each box costs a style read too.
 */
function RowBones() {
  return Array.from({ length: 16 }, (_, i) => (
    <div key={i} className="flex h-13.25 items-center gap-4 border-b ps-13.25 pe-5">
      <SkeletonBox width={28} height={28} radius="var(--radius-sm)" />
      <span className="ms-4 w-[min(--spacing(68),30%)] shrink-0">
        <SkeletonBox width={`${45 + ((i * 17) % 30)}%`} height={10} />
      </span>
      <span className="min-w-0 flex-1">
        <SkeletonBox width={`${55 + ((i * 23) % 35)}%`} height={10} />
      </span>
    </div>
  ));
}

/** Unread threads in the inbox (or one lane of it), across the filtered mailbox(es). */
function useUnreadCount(filter: ThreadFilter) {
  const { data } = useCounts();
  if (filter.view !== "inbox" || filter.lane || !data) return 0;
  return data.counts
    .filter((c) => !filter.mailbox || c.mailboxId === filter.mailbox)
    .reduce((sum, c) => sum + c.unread, 0);
}
