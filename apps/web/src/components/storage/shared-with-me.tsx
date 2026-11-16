// What others shared with the signed-in person (ADR 0034 decision 4), in any workspace, newest
// first: each row opens its link page.
import { TableLoadMoreItem } from "react-aria-components/Table";
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
import { useSharedWithMe } from "@/hooks/use-storage.ts";
import { COLUMN, DAY, FileTableBones, Muted, NameCell } from "./file-table.tsx";
import { StorageFrame } from "./storage-frame.tsx";

const ROLE = { viewer: "Viewer", commenter: "Commenter", editor: "Editor" } as const;

export function SharedWithMe() {
  const shared = useSharedWithMe();
  return (
    <StorageFrame title={<Heading className="truncate text-md">Shared with me</Heading>}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shared.isPending ? (
          <Skeleton loading label="Loading shared files" skeleton={<FileTableBones />}>
            {null}
          </Skeleton>
        ) : shared.isError ? (
          <div className="flex h-full flex-col">
            <ListFailed retry={() => void shared.refetch()} />
          </div>
        ) : !shared.items.length ? (
          <div className="flex h-full flex-col">
            <EmptyState
              figure="drawer"
              title="Nothing shared with you yet"
              description="Files and folders people share with you show up here."
            />
          </div>
        ) : (
          <Table variant="page" rowSize="lg" aria-label="Shared with me">
            <TableHeader>
              <TableColumn isRowHeader>Name</TableColumn>
              <TableColumn className="w-48 max-md:hidden">Workspace</TableColumn>
              <TableColumn className={COLUMN.date}>Shared</TableColumn>
              <TableColumn className={COLUMN.size}>Role</TableColumn>
            </TableHeader>
            <TableBody>
              {shared.items.map((item) => (
                <TableRow
                  key={item.node.id}
                  id={item.node.id}
                  textValue={item.node.name}
                  {...(item.shareId ? { href: `/s/${encodeURIComponent(item.shareId)}` } : {})}
                >
                  <TableCell>
                    <NameCell
                      kind={item.node.kind}
                      name={item.node.name}
                      mimeType={item.node.mimeType}
                    />
                  </TableCell>
                  <TableCell className="max-md:hidden">
                    <span className="block truncate text-muted-foreground">{item.orgName}</span>
                  </TableCell>
                  <TableCell className={COLUMN.date}>
                    <Muted>{DAY.format(new Date(item.sharedAt))}</Muted>
                  </TableCell>
                  <TableCell>
                    <Muted>{ROLE[item.role]}</Muted>
                  </TableCell>
                </TableRow>
              ))}
              <TableLoadMoreItem
                onLoadMore={shared.hasNextPage ? () => void shared.fetchNextPage() : undefined}
                isLoading={shared.isFetchingNextPage}
              />
            </TableBody>
          </Table>
        )}
      </div>
    </StorageFrame>
  );
}
