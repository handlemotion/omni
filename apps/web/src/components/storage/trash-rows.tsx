// Trash's items as the folder page's rows (`file-sections.tsx`): floating, undivided, inset
// 10px and rounded, one hover highlight springing between them, virtualized against the page's
// scroll. Each row: the kind's tile and the name, then its kind, size and the day it was deleted,
// and its menu (Restore, Delete forever). The next page loads as the end nears.
import { memo } from "react";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { ListLayout, Virtualizer } from "react-aria-components/Virtualizer";
import { SkeletonBox } from "skullet/react";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { KEEP_IN_MENU } from "./file-card.tsx";
import { FileTile, TypeBadge } from "./file-glyph.tsx";
import { ROWS_LAYOUT, RowHover } from "./file-sections.tsx";
import { DAY } from "./file-table.tsx";

export interface TrashRowsProps {
  label: string;
  nodes: StorageNode[];
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  loadMore?: (() => void) | undefined;
  isLoadingMore?: boolean;
}

export const TrashRows = memo(function TrashRows(props: TrashRowsProps) {
  return (
    <div className="pt-2 pb-6">
      <RowHover>
        <Virtualizer layout={ListLayout} layoutOptions={ROWS_LAYOUT}>
          <GridList
            aria-label={props.label}
            // Transparent: the hover highlight sits under the rows. The virtualizer gives its
            // sizer and row wrappers no width, so they take the list's.
            className="bg-transparent *:w-full *:*:w-full"
          >
            <Collection items={props.nodes} dependencies={[props.menu]}>
              {(node) => <TrashRow node={node} menu={props.menu(node)} />}
            </Collection>
            <GridListLoadMoreItem onLoadMore={props.loadMore} isLoading={props.isLoadingMore} />
          </GridList>
        </Virtualizer>
      </RowHover>
    </div>
  );
});

function TrashRow(props: { node: StorageNode; menu: SettingsRowMenuItem[] }) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  return (
    <GridListItem
      id={node.id}
      textValue={node.name}
      // 48px: a 32px tile, 8px above and below (`FileRow`'s).
      className="mx-2.5 h-12 gap-3 rounded-lg ps-2 pe-1"
    >
      <FileTile kind={type?.kind ?? "folder"} />
      <span className="min-w-0 flex-1 truncate text-foreground">{node.name}</span>
      {/* The secondary columns, muted, in tabular figures; they leave as the list narrows. */}
      <span className="w-16 shrink-0 @max-xl:hidden">
        {type && <TypeBadge label={type.label} />}
      </span>
      <span className="w-20 shrink-0 text-end text-muted-foreground tabular-nums">
        {type ? formatBytes(node.size) : ""}
      </span>
      <span className="w-28 shrink-0 text-end text-muted-foreground tabular-nums @max-2xl:hidden">
        {node.trashedAt ? DAY.format(new Date(node.trashedAt)) : ""}
      </span>
      {/* Shown on the row's hover and focus, and while its menu is open; always on touch. A row
          with no action gets no `data-hovered`, so `group-hover` would never fire: plain :hover. */}
      <span
        {...KEEP_IN_MENU}
        className="shrink-0 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-[:hover]:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
      >
        <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu} lazy />
      </span>
    </GridListItem>
  );
}

/** Trash while its rows load: skullet's boxes on the rows' own grid. */
export function TrashRowsBones() {
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
