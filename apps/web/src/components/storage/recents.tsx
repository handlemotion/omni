import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { ListFailed } from "@/components/inbox/thread-list";
import { Heading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDrives, useSharedWithMe } from "@/hooks/use-storage.ts";
import { driveKey, driveOf, type StorageNode } from "@/lib/storage.ts";
import { storageRecentQuery } from "@/lib/storage-find.ts";
import { COLUMN, DAY, FileTableBones, Muted, NameCell } from "./file-table.tsx";
import { useStorageHref } from "./file-list.tsx";
import { StorageFrame } from "./storage-frame.tsx";

interface Row {
  node: Pick<StorageNode, "id" | "kind" | "name" | "mimeType" | "updatedAt">;
  where: string;
  href: string;
}

const SHARED_LABEL = "Shared with you";

const SHARED_PAGES = 5;

function useRows() {
  const recent = useQuery(storageRecentQuery());
  const shared = useSharedWithMe();
  const pages = shared.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = shared;
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    if (pages < SHARED_PAGES) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, pages]);
  const { drives } = useDrives();
  const href = useStorageHref();
  const label = (node: StorageNode) =>
    drives.find((each) => driveKey(each.drive) === driveKey(driveOf(node)))?.label ?? "";
  const own: Row[] = (recent.data ?? []).map((node) => {
    const folder = href(driveOf(node), node.parentId ?? undefined);
    return {
      node,
      where: label(node),
      href: `${folder}${folder.includes("?") ? "&" : "?"}file=${encodeURIComponent(node.id)}`,
    };
  });
  const theirs: Row[] = shared.items.flatMap((item) =>
    item.shareId
      ? [{ node: item.node, where: SHARED_LABEL, href: `/s/${encodeURIComponent(item.shareId)}` }]
      : [],
  );
  const seen = new Set(own.map((row) => row.node.id));
  const rows = [...own, ...theirs.filter((row) => !seen.has(row.node.id))].toSorted((a, b) =>
    b.node.updatedAt.localeCompare(a.node.updatedAt),
  );
  return {
    rows,
    isPending: recent.isPending || shared.isPending,
    isError: recent.isError || shared.isError || isFetchNextPageError,
    retry: () => {
      void recent.refetch();
      void shared.refetch();
    },
  };
}

/** The files changed most recently in the member's spaces, and what is shared with them. */
export function Recents() {
  const recents = useRows();
  return (
    <StorageFrame title={<Heading className="truncate text-md">Recents</Heading>}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {recents.isPending ? (
          <Skeleton loading label="Loading recent files" skeleton={<FileTableBones />}>
            {null}
          </Skeleton>
        ) : recents.isError ? (
          <div className="flex h-full flex-col">
            <ListFailed retry={recents.retry} />
          </div>
        ) : !recents.rows.length ? (
          <div className="flex h-full flex-col">
            <EmptyState figure="drawer" title="No files yet" />
          </div>
        ) : (
          <Table variant="page" rowSize="lg" aria-label="Recents">
            <TableHeader>
              <TableColumn isRowHeader>Name</TableColumn>
              <TableColumn className="w-48 max-md:hidden">Where</TableColumn>
              <TableColumn className={COLUMN.date}>Modified</TableColumn>
            </TableHeader>
            <TableBody>
              {recents.rows.map((row) => (
                <TableRow
                  key={row.node.id}
                  id={row.node.id}
                  textValue={row.node.name}
                  href={row.href}
                >
                  <TableCell>
                    <NameCell
                      kind={row.node.kind}
                      name={row.node.name}
                      mimeType={row.node.mimeType}
                    />
                  </TableCell>
                  <TableCell className="max-md:hidden">
                    <span className="block truncate text-muted-foreground">{row.where}</span>
                  </TableCell>
                  <TableCell className={COLUMN.date}>
                    <Muted>{DAY.format(new Date(row.node.updatedAt))}</Muted>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </StorageFrame>
  );
}
