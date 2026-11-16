// The table Storage's lists share (ADR 0034 decision 8): Name, a date, Size, and each row's menu,
// on the table's `page` variant (rows 44px, cells from the page's 20px gutter, so the kind icon
// starts where the header's title does, and the row's menu 10px in, under the header's actions).
// Dates and sizes are muted, in tabular figures, so the names carry the row.
import { TableLoadMoreItem } from "react-aria-components/Table";
import { SkeletonBox } from "skullet/react";
import { IconFile, IconFolder } from "@/components/icons/central";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";

export const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

// Column widths; the date column leaves on a phone, where the name needs the room.
export const COLUMN = { date: "w-36 max-sm:hidden", size: "w-24", menu: "w-13.5" } as const;

export function FileTable(props: {
  label: string;
  nodes: StorageNode[];
  /** The date column: when it last changed, or when it went to Trash. */
  date: { title: string; of: (node: StorageNode) => string | null };
  /** Where a row leads (a folder's page). */
  href?: (node: StorageNode) => string | undefined;
  /** What pressing a row without a link does (a file downloads). */
  onAction?: (node: StorageNode) => void;
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  loadMore?: (() => void) | undefined;
  isLoadingMore?: boolean;
}) {
  return (
    <Table variant="page" aria-label={props.label}>
      <TableHeader>
        <TableColumn isRowHeader>Name</TableColumn>
        <TableColumn className={COLUMN.date}>{props.date.title}</TableColumn>
        <TableColumn className={COLUMN.size}>Size</TableColumn>
        <TableColumn className={COLUMN.menu}>
          <span className="sr-only">Actions</span>
        </TableColumn>
      </TableHeader>
      <TableBody>
        {props.nodes.map((node) => {
          const href = props.href?.(node);
          const when = props.date.of(node);
          const press = href
            ? { href }
            : props.onAction
              ? { onAction: () => props.onAction?.(node) }
              : {};
          return (
            <TableRow key={node.id} id={node.id} textValue={node.name} {...press}>
              <TableCell>
                <NameCell kind={node.kind} name={node.name} />
              </TableCell>
              <TableCell className={COLUMN.date}>
                <Muted>{when ? DAY.format(new Date(when)) : "–"}</Muted>
              </TableCell>
              <TableCell>
                <Muted>{node.kind === "file" ? formatBytes(node.size) : "–"}</Muted>
              </TableCell>
              <TableCell actions>
                <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu(node)} />
              </TableCell>
            </TableRow>
          );
        })}
        <TableLoadMoreItem onLoadMore={props.loadMore} isLoading={props.isLoadingMore} />
      </TableBody>
    </Table>
  );
}

/** The kind's icon and the name, 12px apart, the name cut with an ellipsis. */
export function NameCell(props: { kind: StorageNode["kind"]; name: string }) {
  const Icon = props.kind === "folder" ? IconFolder : IconFile;
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Icon className="size-icon shrink-0 text-muted-foreground" />
      <span className="truncate">{props.name}</span>
    </span>
  );
}

/** A secondary column's value: muted, in tabular figures. */
export function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground tabular-nums">{children}</span>;
}

/** The table while its rows load: skullet's boxes on the rows' own grid. */
export function FileTableBones() {
  return (
    <div>
      <div className="h-9 border-b" />
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 border-b px-5">
          <SkeletonBox width={15} height={15} radius="var(--radius-sm)" />
          <span className="min-w-0 flex-1">
            <SkeletonBox width={`${25 + ((i * 17) % 30)}%`} height={10} />
          </span>
          <span className="w-36 max-sm:hidden">
            <SkeletonBox width={72} height={10} />
          </span>
          <span className="w-24">
            <SkeletonBox width={44} height={10} />
          </span>
          <span className="w-8.5" />
        </div>
      ))}
    </div>
  );
}
