import { memo } from "react";
import { TableLoadMoreItem } from "react-aria-components/Table";
import { SkeletonBox } from "skullet/react";
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
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { FileTile, TypeBadge } from "./file-glyph.tsx";

export const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export const COLUMN = {
  kind: "w-24 max-md:hidden",
  date: "w-36 max-sm:hidden",
  size: "w-24",
  menu: "w-13.5",
} as const;

export interface FileTableProps {
  label: string;
  nodes: StorageNode[];
  /** The date column: when it last changed, or when it went to Trash. */
  date: { title: string; of: (node: StorageNode) => string | null };
  /** Where a row leads (a folder's page). */
  href?: ((node: StorageNode) => string | undefined) | undefined;
  /** What pressing a row without a link does. */
  onAction?: ((node: StorageNode) => void) | undefined;
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  loadMore?: (() => void) | undefined;
  isLoadingMore?: boolean;
}

/** Memoized: the folder page re-renders as the preview opens and the panel resizes. */
export const FileTable = memo(function FileTable(props: FileTableProps) {
  return (
    <Table variant="page" rowSize="lg" aria-label={props.label}>
      <TableHeader>
        <TableColumn isRowHeader>Name</TableColumn>
        <TableColumn className={COLUMN.kind}>Kind</TableColumn>
        <TableColumn className={COLUMN.size}>Size</TableColumn>
        <TableColumn className={COLUMN.date}>{props.date.title}</TableColumn>
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
                <NameCell kind={node.kind} name={node.name} mimeType={node.mimeType} />
              </TableCell>
              <TableCell className={COLUMN.kind}>
                {node.kind === "file" && (
                  <TypeBadge label={fileType(node.name, node.mimeType).label} />
                )}
              </TableCell>
              <TableCell>
                <Muted>{node.kind === "file" ? formatBytes(node.size) : "–"}</Muted>
              </TableCell>
              <TableCell className={COLUMN.date}>
                <Muted>{when ? DAY.format(new Date(when)) : "–"}</Muted>
              </TableCell>
              <TableCell actions>
                <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu(node)} lazy />
              </TableCell>
            </TableRow>
          );
        })}
        <TableLoadMoreItem onLoadMore={props.loadMore} isLoading={props.isLoadingMore} />
      </TableBody>
    </Table>
  );
});

/** Folders open as links; only files are picked. */
export function folderIds(nodes: StorageNode[]) {
  return nodes.filter((node) => node.kind === "folder").map((node) => node.id);
}

/** The kind's 32px tile and the name, 12px apart, the name cut with an ellipsis. */
export function NameCell(props: {
  kind: StorageNode["kind"];
  name: string;
  mimeType?: string | null | undefined;
}) {
  const kind =
    props.kind === "folder" ? "folder" : fileType(props.name, props.mimeType ?? null).kind;
  return (
    <span className="flex min-w-0 items-center gap-3">
      <FileTile kind={kind} />
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
        <div key={i} className="flex h-14 items-center gap-3 border-b px-5">
          <SkeletonBox width={32} height={32} radius="var(--radius-lg)" />
          <span className="min-w-0 flex-1">
            <SkeletonBox width={`${25 + ((i * 17) % 30)}%`} height={10} />
          </span>
          <span className="w-24 max-md:hidden">
            <SkeletonBox width={36} height={14} radius="var(--radius-sm)" />
          </span>
          <span className="w-24">
            <SkeletonBox width={44} height={10} />
          </span>
          <span className="w-36 max-sm:hidden">
            <SkeletonBox width={72} height={10} />
          </span>
          <span className="w-8.5" />
        </div>
      ))}
    </div>
  );
}
