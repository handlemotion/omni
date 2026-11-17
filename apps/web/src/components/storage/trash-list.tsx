// Storage's Trash (ADR 0034 decision 5): what the member may restore, newest first, with Restore
// and Delete forever on each row.
import { useCallback, useState } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconRestore, IconTrash } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Heading } from "@/components/ui/heading";
import { useRestoreNode, useStorageTrash } from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { DeleteForeverDialog } from "./file-dialogs.tsx";
import { NodeMenu } from "./node-menu.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { StorageFrame } from "./storage-frame.tsx";
import { TrashRows, TrashRowsBones } from "./trash-rows.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";

export function TrashList() {
  const trash = useStorageTrash();
  const restore = useRestoreNode();
  const [deleting, setDeleting] = useState<StorageNode | null>(null);
  const restoreNode = restore.mutate;
  const fetchNextPage = trash.fetchNextPage;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  // Stable, so the table's rows render only when they change.
  const menu = useCallback(
    (node: StorageNode): SettingsRowMenuItem[] => [
      {
        icon: IconRestore,
        label: "Restore",
        onAction: () =>
          restoreNode(node.id, {
            onError: (error) => storageErrorToast(error, "It was not restored"),
          }),
      },
      { icon: IconTrash, label: "Delete forever", danger: true, onAction: () => setDeleting(node) },
    ],
    [restoreNode],
  );
  return (
    <StorageFrame
      title={<Heading className="truncate text-md">Trash</Heading>}
      // With rows to read it against; the empty state says it itself.
      caption={trash.nodes.length > 0 && "Deleted forever after 30 days"}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trash.isPending ? (
          <Skeleton loading label="Loading Trash" skeleton={<TrashRowsBones />}>
            {null}
          </Skeleton>
        ) : trash.isError ? (
          <div className="flex h-full flex-col">
            <ListFailed retry={() => void trash.refetch()} />
          </div>
        ) : !trash.nodes.length ? (
          <div className="flex h-full flex-col">
            <EmptyState
              figure="drawer"
              title="Trash is empty"
              description="Deleted files stay here for 30 days."
            />
          </div>
        ) : (
          <NodeMenu nodes={trash.nodes} menu={menu}>
            <TrashRows
              label="Trash"
              nodes={trash.nodes}
              menu={menu}
              loadMore={trash.hasNextPage ? loadMore : undefined}
              isLoadingMore={trash.isFetchingNextPage}
            />
          </NodeMenu>
        )}
      </div>
      <UploadsPanel />
      {deleting && <DeleteForeverDialog node={deleting} onClose={() => setDeleting(null)} />}
    </StorageFrame>
  );
}
