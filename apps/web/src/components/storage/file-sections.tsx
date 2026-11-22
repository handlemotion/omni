import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import type { NodeSelection } from "@/hooks/use-node-selection.ts";
import { useStorageView, type StorageView } from "@/hooks/use-storage-view.ts";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { CARDS_LAYOUT, CardsLayout } from "./cards-layout.ts";
import { FileCard, FileCardBones, KEEP_IN_MENU } from "./file-card.tsx";
import { NodeName, type ItemName } from "./name-field.tsx";
import { DraftCard, DraftRow, type DraftHandlers } from "./folder-draft.tsx";
import { TypeBadge } from "./file-glyph.tsx";
import { RowTile } from "./row-tile.tsx";
import { DAY } from "./file-table.tsx";
import { useWarmOnHover } from "./preview/warm-preview.ts";
import { GAP_MS, useDriveDrag } from "./drive-drag-state.ts";
import { DROP_TARGET, GAP, LIFTED, useGapAt, useSurfaceDrag, type NodeDrag } from "./node-drag.tsx";

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
  /**
   * Folder cards show a few of their files; off through a shared link's door, for every item or
   * for those `peek` returns false for.
   */
  peek?: Peek;
  /** Dragging items onto folders (`node-drag.tsx`); off without it. */
  drag?: NodeDrag | undefined;
  /** Picking several items for a bulk action; off without it. */
  selection?: NodeSelection | undefined;
}

type Peek = boolean | ((node: StorageNode) => boolean) | undefined;

const peeks = (peek: Peek, node: StorageNode) => (typeof peek === "function" ? peek(node) : peek);

/** New folders not yet in the list, and their fields' handlers. */
export interface Drafts {
  list: FolderDraft[];
  handlers: DraftHandlers;
}

/**
 * A folder's items as one surface, folders first, then files, with no section titles: squares
 * unless the person chose rows. Only a file is picked, to preview it; a folder's press
 * follows its link. Memoized: the folder page re-renders as the preview opens and
 * the panel resizes.
 */
export const FileSections = memo(function FileSections(props: FileSectionsProps) {
  const [view] = useStorageView();
  const folders = props.nodes.filter((n) => n.kind === "folder");
  const files = props.nodes.filter((n) => n.kind === "file");
  const nodes = [...folders, ...files];
  const here = props.drag?.here?.place;
  const folderGap = useGapAt(here, folders, "folder");
  const fileGap = useGapAt(here, files, "file");
  const gap = folderGap ?? (fileGap === null ? null : folders.length + fileGap);
  const { open, selection } = props;
  const picking = !!selection?.active;
  const drafts = props.drafts?.list.map((draft) => draft.key) ?? [];
  const chosen: SelectionProps =
    picking && selection
      ? {
          selectionMode: "multiple",
          selectionBehavior: "toggle",
          selectedKeys: nodes.filter((n) => selection.ids.has(n.id)).map((n) => n.id),
          onSelectionChange: (keys: Selection) => selection.changeIn(nodes, keys),
          disabledKeys: [GAP_KEY, ...drafts],
        }
      : {
          selectionMode: "single",
          selectionBehavior: "replace",
          selectedKeys: open.id ? [open.id] : [],
          onSelectionChange: (keys: Selection) => {
            const [id] = keys === "all" ? [] : [...keys];
            open.onChange(id === undefined ? null : String(id));
          },
          disabledKeys: [GAP_KEY, ...drafts, ...folders.map((n) => n.id)],
          disabledBehavior: "selection",
        };
  return (
    <div className="flex w-full flex-col pt-2 pb-6" {...selection?.start}>
      <Items
        view={view}
        label={props.label}
        nodes={nodes}
        drafts={props.drafts}
        rename={props.rename}
        href={props.href}
        fileUrl={props.fileUrl}
        menu={props.menu}
        peek={props.peek}
        drag={props.drag}
        gap={gap}
        picking={picking}
        selection={chosen}
      />
      {props.loadMore && <LoadMore onLoadMore={props.loadMore} />}
    </div>
  );
});

/** Squares or rows, for every folder: in the page's header. */
export function ViewToggle() {
  const [view, setView] = useStorageView();
  return (
    <ToggleGroup
      bare
      size="sq-xs"
      aria-label="Layout"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[view]}
      onSelectionChange={(keys) => {
        const [next] = [...keys];
        if (next === "rows" || next === "cards") setView(next);
      }}
    >
      <LayoutOption id="cards" label="Cards">
        <IconCards />
      </LayoutOption>
      <LayoutOption id="rows" label="Rows">
        <IconRows />
      </LayoutOption>
    </ToggleGroup>
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
  | "selectionMode"
  | "selectionBehavior"
  | "selectedKeys"
  | "onSelectionChange"
  | "disabledKeys"
  | "disabledBehavior"
>;

interface DraftItem {
  id: string;
  draft: FolderDraft;
  handlers: DraftHandlers;
}

interface GapItem {
  id: typeof GAP_KEY;
  gap: true;
}

const GAP_KEY = "drive-drag-gap";

function Items(props: {
  view: StorageView;
  label: string;
  nodes: StorageNode[];
  drafts?: Drafts | undefined;
  rename?: InlineRename | undefined;
  href: (node: StorageNode) => string;
  fileUrl: (node: StorageNode) => string;
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  selection?: SelectionProps | undefined;
  peek?: Peek;
  drag?: NodeDrag | undefined;
  gap?: number | null;
  picking?: boolean;
}) {
  const href = (node: StorageNode) =>
    node.kind === "folder" && !props.picking ? props.href(node) : undefined;
  const drafts = props.drafts?.list ?? [];
  const handlers = props.drafts?.handlers;
  const listed: (StorageNode | GapItem)[] = props.nodes;
  const nodes =
    props.gap === null || props.gap === undefined
      ? listed
      : listed.toSpliced(props.gap, 0, { id: GAP_KEY, gap: true });
  const items: (StorageNode | DraftItem | GapItem)[] = handlers
    ? [...drafts.map((draft) => ({ id: draft.key, draft, handlers })), ...nodes]
    : nodes;
  const top = useRevealDraft(drafts.find((d) => d.step === "naming")?.key);
  const shifting = useShifting();
  const renaming = props.rename?.renaming;
  const named =
    renaming?.at === "list" && props.nodes.some((n) => n.id === renaming.id) ? renaming : null;
  const nameOf = (node: StorageNode) =>
    (named?.id === node.id && props.rename
      ? { ...named, finish: props.rename.finish }
      : undefined) satisfies ItemName | undefined;
  const typing = drafts.some((d) => d.step === "naming") || named?.step === "naming";
  const list = {
    "aria-label": props.label,
    items,
    disabledKeys: [GAP_KEY],
    shouldSelectOnPressUp: true,
    dependencies: [named, props.picking],
    ...props.selection,
    ...(typing ? { keyboardNavigationBehavior: "tab" as const } : {}),
  };
  if (props.view === "cards") {
    return (
      <>
        {top}
        <Virtualizer layout={CardsLayout} layoutOptions={CARDS_LAYOUT}>
          <GridList {...list} layout="grid" className={`bg-transparent ${shifting}`}>
            {(node) =>
              "gap" in node ? (
                <GapCard />
              ) : "draft" in node ? (
                <DraftCard draft={node.draft} handlers={node.handlers} />
              ) : (
                <FileCard
                  node={node}
                  href={href(node)}
                  url={props.fileUrl(node)}
                  fileUrl={props.fileUrl}
                  peek={peeks(props.peek, node)}
                  menu={props.menu(node)}
                  name={nameOf(node)}
                  drag={props.drag}
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
        <GridList {...list} className={`bg-transparent *:w-full *:*:w-full ${shifting}`}>
          {(node) =>
            "gap" in node ? (
              <GapRow />
            ) : "draft" in node ? (
              <DraftRow draft={node.draft} handlers={node.handlers} />
            ) : (
              <FileRow
                node={node}
                href={href(node)}
                url={props.fileUrl(node)}
                menu={props.menu(node)}
                prefetch={peeks(props.peek, node) !== false}
                name={nameOf(node)}
                drag={props.drag}
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
  url: string;
  prefetch: boolean;
  menu: SettingsRowMenuItem[];
  name?: ItemName | undefined;
  drag: NodeDrag | undefined;
}) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  const prefetch = usePrefetchFolder();
  const warm = useWarmOnHover(node, props.url);
  const lift = useSurfaceDrag(node, "row", props.drag);
  return (
    <GridListItem
      ref={lift.ref}
      {...lift.props}
      id={node.id}
      href={props.href}
      textValue={node.name}
      {...warm}
      onHoverStart={
        node.kind === "folder" && props.prefetch ? () => prefetch(node) : warm.onHoverStart
      }
      className={`mx-2.5 h-12 gap-3 rounded-lg ps-2 pe-1 selected:bg-accent ${DROP_TARGET} ${LIFTED}`}
    >
      <RowTile node={node} url={props.url} />
      <NodeName node={node} name={props.name} />
      <span data-drag-trim className="w-16 shrink-0 @max-xl:hidden">
        {type && <TypeBadge label={type.label} />}
      </span>
      <span data-drag-trim className="w-20 shrink-0 text-end text-muted-foreground tabular-nums">
        {type ? formatBytes(node.size) : ""}
      </span>
      <span
        data-drag-trim
        className="w-28 shrink-0 text-end text-muted-foreground tabular-nums @max-2xl:hidden"
      >
        {DAY.format(new Date(node.updatedAt))}
      </span>
      <span
        {...KEEP_IN_MENU}
        data-drag-trim
        className="shrink-0 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 group-data-selected:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
      >
        <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu} lazy />
      </span>
    </GridListItem>
  );
}

function GapRow() {
  return (
    <GridListItem id={GAP_KEY} textValue="" className={`mx-2.5 h-12 ${GAP}`} data-drive-gap>
      <span />
    </GridListItem>
  );
}

function GapCard() {
  return (
    <GridListItem
      id={GAP_KEY}
      textValue=""
      className={`flex-col items-stretch gap-2 rounded-xl p-1.5 ${GAP}`}
      data-drive-gap
    >
      <div className="aspect-square" />
      <div className="invisible flex flex-col gap-1 text-sm">
        <span>&nbsp;</span>
        <span className="text-xs">&nbsp;</span>
      </div>
    </GridListItem>
  );
}

function useShifting() {
  const { phase } = useDriveDrag();
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (phase) return setSettling(true);
    const timer = setTimeout(() => setSettling(false), GAP_MS * 2);
    return () => clearTimeout(timer);
  }, [phase]);
  return phase || settling
    ? "*:*:transition-[top,left] *:*:duration-200 *:*:ease-out motion-reduce:*:*:transition-none"
    : "";
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

function useRevealDraft(naming: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (naming) ref.current?.scrollIntoView({ block: "nearest" });
  }, [naming]);
  return <div ref={ref} aria-hidden className="scroll-mt-12" />;
}

/** Rows are 48px, as `FileRow` draws them, 2px apart. */
export const ROWS_LAYOUT = { rowSize: 48, gap: 2, loaderSize: 0 };

function LoadMore(props: { onLoadMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useRef(props.onLoadMore);
  load.current = props.onLoadMore;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => entries.at(-1)?.isIntersecting && load.current(),
      { rootMargin: "200% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} aria-hidden className="h-px" />;
}

/** The page while it loads, in the folder's view. */
export function FileSectionsBones() {
  const [view] = useStorageView();
  if (view === "cards") {
    return (
      <div className="pt-2">
        <FileCardBones count={12} />
      </div>
    );
  }
  return (
    <div className="px-2.5 pt-2">
      {Array.from({ length: 10 }, (_, i) => (
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
  );
}
