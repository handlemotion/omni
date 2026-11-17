// A folder's contents as two sections, Folders then Files, each laid out its own way, rows or
// cards (folders default to cards, files to rows; `use-storage-view.ts`). A section's header
// carries its label and count, and at its far end the two layout icons, shown while the section
// is hovered or focused. Rows float as the mail list's do: undivided, inset 10px, rounded, one
// hover highlight springing between them. The open file is the Files section's one selected
// item: a click or the arrow keys select a file and its preview follows.
//
// One page scroll for both sections. Each section is virtualized against it: only the rows and
// cards near the screen are rendered, however many pages of the folder have loaded, and the
// next page loads as the end nears.
import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Selection } from "react-aria-components";
import { ListLayout, Virtualizer } from "react-aria-components/Virtualizer";
import { SkeletonBox } from "skullet/react";
import { IconCards, IconRows } from "@/components/icons/central";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { usePrefetchFolder } from "@/hooks/use-storage.ts";
import type { FolderDraft } from "@/hooks/use-folder-drafts.ts";
import type { InlineRename } from "@/hooks/use-inline-rename.ts";
import { useStorageView, type StorageSection, type StorageView } from "@/hooks/use-storage-view.ts";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { CARDS_LAYOUT, CardsLayout } from "./cards-layout.ts";
import { FileCard, FileCardBones, KEEP_IN_MENU } from "./file-card.tsx";
import { NodeName, type ItemName } from "./name-field.tsx";
import { DraftCard, DraftRow, type DraftHandlers } from "./folder-draft.tsx";
import { TypeBadge } from "./file-glyph.tsx";
import { RowTile } from "./row-tile.tsx";
import { DAY } from "./file-table.tsx";
import { DROP_TARGET, useNodeDragAndDrop, type NodeDrag } from "./node-drag.tsx";

export interface FileSectionsProps {
  label: string;
  nodes: StorageNode[];
  href: (node: StorageNode) => string;
  fileUrl: (node: StorageNode) => string;
  /** The file open in the preview. */
  open: { id: string | undefined; onChange: (id: string | null) => void };
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  loadMore?: (() => void) | undefined;
  /** New folders not yet in the list, first in Folders (`use-folder-drafts.ts`). */
  drafts?: Drafts | undefined;
  /** The item whose name is a field (`use-inline-rename.ts`). */
  rename?: InlineRename | undefined;
  /** Folder cards show a few of their files; off through a shared link's door. */
  peek?: boolean | undefined;
  /** Dragging items onto folders (`node-drag.tsx`); off without it. */
  drag?: NodeDrag | undefined;
}

/** New folders not yet in the list, and their fields' handlers. */
export interface Drafts {
  list: FolderDraft[];
  handlers: DraftHandlers;
}

/** Memoized: the folder page re-renders as the preview opens and the panel resizes. */
export const FileSections = memo(function FileSections(props: FileSectionsProps) {
  const folders = props.nodes.filter((n) => n.kind === "folder");
  const files = props.nodes.filter((n) => n.kind === "file");
  const folderCount = folders.length + (props.drafts?.list.length ?? 0);
  const { open } = props;
  return (
    <div className="flex w-full flex-col pb-6">
      {folderCount > 0 && (
        <Section section="folders" label="Folders" count={folderCount} first>
          {(view) => (
            <Items
              view={view}
              label={`${props.label} folders`}
              nodes={folders}
              drafts={props.drafts}
              rename={props.rename}
              href={props.href}
              fileUrl={props.fileUrl}
              menu={props.menu}
              peek={props.peek}
              drag={props.drag}
            />
          )}
        </Section>
      )}
      {files.length > 0 && (
        <Section section="files" label="Files" count={files.length} first={folderCount === 0}>
          {(view) => (
            <Items
              view={view}
              label={`${props.label} files`}
              nodes={files}
              rename={props.rename}
              href={props.href}
              fileUrl={props.fileUrl}
              menu={props.menu}
              drag={props.drag}
              selection={{
                selectionMode: "single",
                selectionBehavior: "replace",
                selectedKeys: open.id ? [open.id] : [],
                onSelectionChange: (keys: Selection) => {
                  const [id] = keys === "all" ? [] : [...keys];
                  open.onChange(id === undefined ? null : String(id));
                },
              }}
            />
          )}
        </Section>
      )}
      {props.loadMore && <LoadMore onLoadMore={props.loadMore} />}
    </div>
  );
});

/** A section: its header, with the layout icons at its end, over its items in that layout. */
function Section(props: {
  section: StorageSection;
  label: string;
  count: number;
  first: boolean;
  children: (view: StorageView) => ReactNode;
}) {
  const [view, setView] = useStorageView(props.section);
  return (
    <section aria-label={props.label} className="group/section flex flex-col">
      {/* 48px, the room above each section; the first 36px, close under the page's title. The
          icons sit 10px in from the end, under the header's actions. */}
      <div
        className={`flex items-end gap-1.5 ps-5 pe-2.5 pb-2 text-sm text-muted-foreground ${props.first ? "h-9" : "h-12"}`}
      >
        {props.label}
        <span className="text-subtle-foreground tabular-nums">{props.count}</span>
        <span className="flex-1" />
        {/* Shown while the section is hovered or holds focus; always on touch. */}
        <div className="-mb-1 opacity-0 transition-opacity duration-150 group-focus-within/section:opacity-100 group-hover/section:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
          <ToggleGroup
            bare
            size="sq-xs"
            aria-label={`${props.label} layout`}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[view]}
            onSelectionChange={(keys) => {
              const [next] = [...keys];
              if (next === "rows" || next === "cards") setView(next);
            }}
          >
            <LayoutOption id="rows" label="Rows">
              <IconRows />
            </LayoutOption>
            <LayoutOption id="cards" label="Cards">
              <IconCards />
            </LayoutOption>
          </ToggleGroup>
        </div>
      </div>
      {props.children(view)}
    </section>
  );
}

function LayoutOption(props: { id: StorageView; label: string; children: ReactNode }) {
  return (
    <TooltipTrigger delay={400}>
      <ToggleGroupItem id={props.id} aria-label={props.label}>
        {props.children}
      </ToggleGroupItem>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

type SelectionProps = Pick<
  React.ComponentProps<typeof GridList>,
  "selectionMode" | "selectionBehavior" | "selectedKeys" | "onSelectionChange"
>;

/** A new folder's place among the items, keyed by its draft's key. */
interface DraftItem {
  id: string;
  draft: FolderDraft;
  handlers: DraftHandlers;
}

/** A section's items, as rows or as cards; folders are links, files are picked. */
function Items(props: {
  view: StorageView;
  label: string;
  nodes: StorageNode[];
  drafts?: Drafts | undefined;
  rename?: InlineRename | undefined;
  href: (node: StorageNode) => string;
  fileUrl: (node: StorageNode) => string;
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  selection?: SelectionProps;
  peek?: boolean | undefined;
  drag?: NodeDrag | undefined;
}) {
  const href = (node: StorageNode) => (node.kind === "folder" ? props.href(node) : undefined);
  const drafts = props.drafts?.list ?? [];
  const handlers = props.drafts?.handlers;
  const items: (StorageNode | DraftItem)[] = handlers
    ? [...drafts.map((draft) => ({ id: draft.key, draft, handlers })), ...props.nodes]
    : props.nodes;
  const top = useRevealDraft(drafts.find((d) => d.step === "naming")?.key);
  const { dragAndDropHooks } = useNodeDragAndDrop(props.nodes, props.drag);
  // The item being renamed here, if it is one of this section's.
  const renaming = props.rename?.renaming;
  const named =
    renaming?.at === "list" && props.nodes.some((n) => n.id === renaming.id) ? renaming : null;
  const nameOf = (node: StorageNode): ItemName | undefined =>
    named?.id === node.id && props.rename ? { ...named, finish: props.rename.finish } : undefined;
  const typing = drafts.some((d) => d.step === "naming") || named?.step === "naming";
  const list = {
    "aria-label": props.label,
    items,
    dragAndDropHooks,
    // Items render again when the name being changed does (they are cached by their node).
    dependencies: [named],
    ...props.selection,
    // While a name is typed, arrows and Home/End stay in its field rather than the list's.
    ...(typing ? { keyboardNavigationBehavior: "tab" as const } : {}),
  };
  if (props.view === "cards") {
    return (
      // Cards 184px, 12px apart, 14px in (`cards-layout.ts`); the cards' own 6px inset
      // puts their squares 20px from the page's edges, like the rows' tiles.
      <>
        {top}
        <Virtualizer layout={CardsLayout} layoutOptions={CARDS_LAYOUT}>
          <GridList {...list} layout="grid" className="bg-transparent">
            {(node) =>
              "draft" in node ? (
                <DraftCard draft={node.draft} handlers={node.handlers} />
              ) : (
                <FileCard
                  node={node}
                  href={href(node)}
                  url={props.fileUrl(node)}
                  fileUrl={props.fileUrl}
                  peek={props.peek}
                  menu={props.menu(node)}
                  name={nameOf(node)}
                />
              )
            }
          </GridList>
        </Virtualizer>
      </>
    );
  }
  return (
    <RowHover>
      {top}
      <Virtualizer layout={ListLayout} layoutOptions={ROWS_LAYOUT}>
        <GridList
          {...list}
          // Transparent: the hover highlight sits under the rows. The virtualizer gives its sizer
          // and row wrappers no width, so they take the list's (as the mail list's do).
          className="bg-transparent *:w-full *:*:w-full"
        >
          {(node) =>
            "draft" in node ? (
              <DraftRow draft={node.draft} handlers={node.handlers} />
            ) : (
              <FileRow
                node={node}
                href={href(node)}
                url={props.fileUrl(node)}
                menu={props.menu(node)}
                prefetch={props.peek !== false}
                name={nameOf(node)}
              />
            )
          }
        </GridList>
      </Virtualizer>
    </RowHover>
  );
}

function FileRow(props: {
  node: StorageNode;
  href: string | undefined;
  /** Where its bytes are read, for an image's or a PDF's tile. */
  url: string;
  /** Folders read their contents on hover; off through a shared link's door. */
  prefetch: boolean;
  menu: SettingsRowMenuItem[];
  /** Its name as a field, while it is renamed. */
  name?: ItemName | undefined;
}) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  const prefetch = usePrefetchFolder();
  return (
    <GridListItem
      id={node.id}
      href={props.href}
      textValue={node.name}
      // Not through a shared link's door: a folder's own list is the member's.
      onHoverStart={props.prefetch ? () => prefetch(node) : undefined}
      // The open file keeps the accent fill, as the open thread's row does. 48px: a 32px tile,
      // 8px above and below.
      className={`mx-2.5 h-12 gap-3 rounded-lg ps-2 pe-1 selected:bg-accent ${DROP_TARGET}`}
    >
      <RowTile node={node} url={props.url} />
      <NodeName node={node} name={props.name} />
      {/* The secondary columns, muted, in tabular figures; they leave as the list narrows. */}
      <span className="w-16 shrink-0 @max-xl:hidden">
        {type && <TypeBadge label={type.label} />}
      </span>
      <span className="w-20 shrink-0 text-end text-muted-foreground tabular-nums">
        {type ? formatBytes(node.size) : ""}
      </span>
      <span className="w-28 shrink-0 text-end text-muted-foreground tabular-nums @max-2xl:hidden">
        {DAY.format(new Date(node.updatedAt))}
      </span>
      {/* Shown on the row's hover and focus, and while its menu is open; always on touch. */}
      <span
        {...KEEP_IN_MENU}
        className="shrink-0 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 group-data-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
      >
        <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu} lazy />
      </span>
    </GridListItem>
  );
}

/** One hover highlight springs between the rows (mail's `RowHover`). */
export function RowHover({ children }: { children: ReactNode }) {
  const hover = useFluidHoverList({
    itemSelector: "[role='row']",
    highlightedSelector: "[data-focus-visible]",
  });
  return (
    <div className="@container relative" {...hover.containerProps}>
      <FluidHoverHighlight {...hover.highlightProps} />
      {children}
    </div>
  );
}

/**
 * A mark at the top of a section's items, scrolled into view (with the section's label above
 * it) when a new folder's name starts being typed there. The draft is the first item, and a
 * virtualized list renders only the items near the screen: scrolled past it, its field would
 * not be there to take focus.
 */
function useRevealDraft(naming: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (naming) ref.current?.scrollIntoView({ block: "nearest" });
  }, [naming]);
  return <div ref={ref} aria-hidden className="scroll-mt-12" />;
}

/** Rows are 48px, as `FileRow` draws them. */
export const ROWS_LAYOUT = { rowSize: 48, loaderSize: 0 };

/** Asks for the folder's next page when this nears the screen (two screens ahead). */
function LoadMore(props: { onLoadMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useRef(props.onLoadMore);
  load.current = props.onLoadMore;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      // The latest entry: a busy page gets several at once, oldest first, and reading the first
      // one missed that the end had come into view, leaving the list stuck there.
      (entries) => entries.at(-1)?.isIntersecting && load.current(),
      { rootMargin: "200% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} aria-hidden className="h-px" />;
}

/** The page while it loads: a few folder cards, then rows, on their own grids. */
export function FileSectionsBones() {
  return (
    <div className="flex flex-col">
      <div className="flex h-9 items-end px-5 pb-2">
        <SkeletonBox width={56} height={10} />
      </div>
      <FileCardBones count={6} />
      <div className="flex h-12 items-end px-5 pb-2">
        <SkeletonBox width={40} height={10} />
      </div>
      <div className="px-2.5">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-12 items-center gap-3 ps-2 pe-10">
            <SkeletonBox width={32} height={32} radius="var(--radius-lg)" />
            <span className="min-w-0 flex-1">
              <SkeletonBox width={`${25 + ((i * 17) % 30)}%`} height={10} />
            </span>
            <span className="w-20">
              <SkeletonBox width={44} height={10} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
