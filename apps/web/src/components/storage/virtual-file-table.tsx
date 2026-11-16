// `FileTable` for long lists (Trash): the same columns and rows, virtualized against the page's
// scroll, so only the rows near the screen are rendered however many pages have loaded. React
// Aria lays a virtualized table out itself (absolutely placed rows of cells, widths from the
// columns' props), so the widths the native table takes from CSS are given here, and the columns
// a narrow window drops (`COLUMN`'s `max-md`, `max-sm`) are left out instead of hidden.
import { memo, useSyncExternalStore } from "react";
import { Collection } from "react-aria-components/Collection";
import { TableLoadMoreItem } from "react-aria-components/Table";
import { TableLayout, Virtualizer } from "react-aria-components/Virtualizer";
import { SettingsRowMenu } from "@/components/settings/kit/settings-row-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes } from "@/lib/storage.ts";
import { TypeBadge } from "./file-glyph.tsx";
import { DAY, Muted, NameCell, type FileTableProps } from "./file-table.tsx";

/** The native table's: a 36px header and its line over 56px rows (`Table`'s `page`, `lg`). */
const LAYOUT = { headingHeight: 37, rowHeight: 56, loaderHeight: 0 };
/** `COLUMN`'s widths, in px; each is its minimum too (React Aria's default minimum is 75px). */
const WIDTH = { kind: 96, size: 96, date: 144, menu: 54 } as const;

/**
 * Positioned cells: centred in the row, as a native cell's `align-middle` puts them. Each sits
 * alone in its own box, so it is its row's `first:` and `last:` both: the native table's
 * padding (the page's 20px gutter at the ends, 16px between) is set here by place instead.
 */
const CELL = {
  first: "flex items-center pb-px last:pe-4",
  middle: "flex items-center pb-px first:ps-4 last:pe-4",
  // The menu's cell keeps its content at its end, 10px in (`TableCell`'s `actions`).
  last: "flex items-center justify-end pb-px first:ps-0",
} as const;
/**
 * The header and each row fill the box the layout gives them: their cells are placed
 * absolutely, so they would have no height, and the header's line and a row's focus outline
 * would sit at their top.
 */
const FILL = "h-full";

function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (change) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", change);
      return () => list.removeEventListener("change", change);
    },
    () => window.matchMedia(query).matches,
  );
}

export const VirtualFileTable = memo(function VirtualFileTable(props: FileTableProps) {
  // Tailwind's `md` and `sm`: where `COLUMN.kind` and `COLUMN.date` show.
  const kind = useMinWidth(768);
  const date = useMinWidth(640);
  return (
    <Virtualizer layout={TableLayout} layoutOptions={LAYOUT}>
      {/* `Table` sizes the table's box to its content (an inline block), and a virtualized
          table's content is as wide as it was last laid out: as a block it follows the page, so
          the columns lay out again when the window narrows. */}
      <Table variant="page" rowSize="lg" aria-label={props.label} className="*:block">
        <TableHeader className={FILL}>
          <TableColumn isRowHeader className={CELL.first}>
            Name
          </TableColumn>
          {kind && (
            <TableColumn width={WIDTH.kind} minWidth={WIDTH.kind} className={CELL.middle}>
              Kind
            </TableColumn>
          )}
          <TableColumn width={WIDTH.size} minWidth={WIDTH.size} className={CELL.middle}>
            Size
          </TableColumn>
          {date && (
            <TableColumn width={WIDTH.date} minWidth={WIDTH.date} className={CELL.middle}>
              {props.date.title}
            </TableColumn>
          )}
          <TableColumn width={WIDTH.menu} minWidth={WIDTH.menu} className={CELL.middle}>
            <span className="sr-only">Actions</span>
          </TableColumn>
        </TableHeader>
        <TableBody>
          <Collection items={props.nodes} dependencies={[kind, date, props.menu, props.date]}>
            {(node) => {
              const href = props.href?.(node);
              const when = props.date.of(node);
              const press = href
                ? { href }
                : props.onAction
                  ? { onAction: () => props.onAction?.(node) }
                  : {};
              return (
                <TableRow className={FILL} id={node.id} textValue={node.name} {...press}>
                  <TableCell className={CELL.first}>
                    <NameCell kind={node.kind} name={node.name} mimeType={node.mimeType} />
                  </TableCell>
                  {kind && (
                    <TableCell className={CELL.middle}>
                      {node.kind === "file" && (
                        <TypeBadge label={fileType(node.name, node.mimeType).label} />
                      )}
                    </TableCell>
                  )}
                  <TableCell className={CELL.middle}>
                    <Muted>{node.kind === "file" ? formatBytes(node.size) : "–"}</Muted>
                  </TableCell>
                  {date && (
                    <TableCell className={CELL.middle}>
                      <Muted>{when ? DAY.format(new Date(when)) : "–"}</Muted>
                    </TableCell>
                  )}
                  <TableCell actions className={CELL.last}>
                    <SettingsRowMenu
                      label={`Actions for ${node.name}`}
                      items={props.menu(node)}
                      lazy
                    />
                  </TableCell>
                </TableRow>
              );
            }}
          </Collection>
          <TableLoadMoreItem onLoadMore={props.loadMore} isLoading={props.isLoadingMore} />
        </TableBody>
      </Table>
    </Virtualizer>
  );
});
