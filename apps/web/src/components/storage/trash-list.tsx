// Storage's Trash (ADR 0034 decision 5): what the member may restore, newest first, with Restore
// and Delete forever on each row.
import { useState } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconRestore, IconTrash } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { Heading } from "@/components/ui/heading";
import { useRestoreNode, useStorageTrash } from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { DeleteForeverDialog } from "./file-dialogs.tsx";
import { FileTable, FileTableBones } from "./file-table.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { StorageFrame } from "./storage-frame.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";

export function TrashList() {
  const trash = useStorageTrash();
  const restore = useRestoreNode();
  const [deleting, setDeleting] = useState<StorageNode | null>(null);
  return (
    <StorageFrame
      title={<Heading className="truncate">Trash</Heading>}
      // With rows to read it against; the empty state says it itself.
      caption={trash.nodes.length > 0 && "Deleted forever after 30 days"}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trash.isPending ? (
          <Skeleton loading label="Loading Trash" skeleton={<FileTableBones />}>
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
          <FileTable
            label="Trash"
            nodes={trash.nodes}
            date={{ title: "Deleted", of: (node) => node.trashedAt }}
            menu={(node) => [
              {
                icon: IconRestore,
                label: "Restore",
                onAction: () =>
                  restore.mutate(node.id, {
                    onError: (error) => storageErrorToast(error, "It was not restored"),
                  }),
              },
              {
                icon: IconTrash,
                label: "Delete forever",
                danger: true,
                onAction: () => setDeleting(node),
              },
            ]}
            loadMore={trash.hasNextPage ? () => void trash.fetchNextPage() : undefined}
            isLoadingMore={trash.isFetchingNextPage}
          />
        )}
      </div>
      <UploadsPanel />
      {deleting && <DeleteForeverDialog node={deleting} onClose={() => setDeleting(null)} />}
    </StorageFrame>
  );
}
