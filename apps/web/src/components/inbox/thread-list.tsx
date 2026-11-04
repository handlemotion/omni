import {
  ArrowsPointingOutIcon,
  PencilSquareIcon,
  ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import { useParams } from "@tanstack/react-router";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Key, Selection } from "react-aria-components";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { ListLayout, Virtualizer } from "react-aria-components/Virtualizer";
import { SearchPopover } from "@/components/search/search-popover";
import { buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { Heading } from "@/components/ui/heading";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { useCounts, useThreads } from "@/hooks/use-mail.ts";
import { useThreadListShortcuts } from "@/hooks/use-thread-list-shortcuts.ts";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";
import { senderLabel } from "@/lib/threads.ts";
import type { ThreadFilter, ThreadSummary, ThreadView } from "@/lib/types.ts";

/** What a list row shows. Threads and search results both map to it. */
export interface ListRow {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  unread: boolean;
  /** The workspace it belongs to, when the list spans more than one. */
  workspace?: string | undefined;
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
  const workspaces = useWorkspaces().data?.workspaces;
  // Stable rows, so the virtualized list's row cache survives renders that don't change them.
  const rows = useMemo(() => {
    // Rows name their workspace only when the list mixes several (no mailbox chosen).
    const names =
      !props.filter.mailbox && workspaces && workspaces.length > 1
        ? new Map(workspaces.map((w) => [w.id, w.name]))
        : undefined;
    return threads.map((thread) => toRow(thread, names?.get(thread.orgId)));
  }, [threads, workspaces, props.filter.mailbox]);
  return (
    <List
      {...props}
      rows={rows}
      count={unread}
      shortcuts={{
        view: props.filter.view,
        threads,
        loadMore: hasNextPage ? () => void fetchNextPage() : undefined,
      }}
      loadMore={hasNextPage ? () => void fetchNextPage() : undefined}
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
  },
) {
  const threads = props.rows;
  const unread = props.count ?? 0;
  const [selected, setSelected] = useState<Selection>(new Set());
  const count = selected === "all" ? threads.length : selected.size;
  const [view, setView] = useViewMode();
  const { threadId } = useParams({ strict: false });
  // List view: an open thread takes the whole width; split view: it sits beside the list.
  const hideList = view === "list" && !!threadId;
  const listRef = useRef<HTMLElement>(null);
  // One hover highlight springs between the rows (transitive's fluid hover). The row moved to with
  // j/k lights the same way whenever the pointer is not over the list.
  const hover = useFluidHoverList({
    itemSelector: "[role='row']",
    highlightedSelector: "[data-focus-visible]",
  });

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
      {/* 8px on the right, the same as the controls' inset from the top. */}
      <header className="flex h-12 shrink-0 items-center gap-2 ps-5 pe-2">
        {/* 1px down: centers the title's capitals on the sidebar header's icons. */}
        <Heading className="translate-y-px">
          {props.title}
          {unread > 0 && <span className="ms-1 text-primary tabular-nums">{unread}</span>}
        </Heading>
        <div className="ms-auto flex items-center gap-2">
          <ToggleGroup
            size="sq-xs"
            aria-label="View"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[view]}
            onSelectionChange={(keys: Set<Key>) => {
              const next = [...keys][0];
              if (next === "list" || next === "split") setView(next);
            }}
          >
            <ToggleGroupItem id="list" aria-label="List">
              <ArrowsPointingOutIcon />
            </ToggleGroupItem>
            <ToggleGroupItem id="split" aria-label="Split">
              <ViewColumnsIcon />
            </ToggleGroupItem>
          </ToggleGroup>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <SearchPopover />
          <Link
            href="/compose"
            aria-keyshortcuts={ariaKeyShortcuts("compose")}
            className={buttonStyles({ intent: "primary" })}
          >
            <PencilSquareIcon />
            Compose
          </Link>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section
          ref={listRef}
          className={`flex min-w-0 flex-1 flex-col ${hideList ? "hidden" : ""}`}
        >
          <div className="flex h-10.5 items-center gap-2 border-b px-5">
            <CheckboxField
              aria-label="Select all"
              isSelected={threads.length > 0 && count === threads.length}
              isIndeterminate={count > 0 && count < threads.length}
              onChange={(all) => setSelected(all ? "all" : new Set())}
            >
              <Checkbox />
            </CheckboxField>
            <span className="text-xs text-subtle-foreground">{props.caption ?? "Most recent"}</span>
          </div>

          {/* Only the rows on screen are in the DOM, so thousands of threads scroll like fifty.
              The list is its own scroll container; rows keep the frame's fixed height. The
              wrapper holds the fluid hover highlight, which sits under the rows and follows the
              list's scroll. */}
          <div className="relative flex min-h-0 flex-1 flex-col" {...hover.containerProps}>
            <FluidHoverHighlight {...hover.highlightProps} />
            <Virtualizer layout={ListLayout} layoutOptions={LIST_LAYOUT}>
              <GridList
                aria-label={props.title}
                // Transparent: the list is positioned, so its own fill would paint over the
                // highlight. The page behind it is already the background.
                className="min-h-0 flex-1 overflow-y-auto bg-transparent"
                // Letters are shortcuts here (j, k, x, e, ...), not type-to-find.
                disallowTypeAhead
                selectionMode="multiple"
                selectionBehavior="toggle"
                selectedKeys={selected}
                onSelectionChange={setSelected}
              >
                {/* `items` lets React Aria cache rows by thread, so a scroll renders only new rows. */}
                <Collection items={threads} dependencies={[props.href]}>
                  {(thread) => <ThreadRow thread={thread} href={props.href(thread.id)} />}
                </Collection>
                {/* Asks for the next page as the end of the list nears. */}
                <GridListLoadMoreItem onLoadMore={props.loadMore} isLoading={props.isLoadingMore} />
              </GridList>
            </Virtualizer>
          </div>
        </section>
        {props.children}
      </div>
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
}

/** Binds the list keys while mounted; a component so `List` can use them only for threads. */
function ListShortcuts(props: Parameters<typeof useThreadListShortcuts>[0]) {
  useThreadListShortcuts(props);
  return null;
}

type ViewMode = "list" | "split";

/** List or split, remembered in this browser. */
function useViewMode() {
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem("omni:view") === "list" ? "list" : "split";
    } catch {
      return "split";
    }
  });
  const set = (next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem("omni:view", next);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
  };
  return [view, set] as const;
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
