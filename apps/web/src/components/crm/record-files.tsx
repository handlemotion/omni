// A company's or deal's Files tab (ADR 0036 decision 5): its folder in Shared, listed and filled
// through Storage's own door and table. The folder is made on the first upload (`POST
// /crm/.../folder`), not by looking; a file dropped anywhere on the tab uploads there. Folders
// open in Drive, where the same folder can be shared like any other.
import { useNavigate } from "@tanstack/react-router";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconDownload, IconFolder, IconUpload } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { FileTable, FileTableBones } from "@/components/storage/file-table";
import { storageErrorToast } from "@/components/storage/storage-errors";
import { UploadsPanel } from "@/components/storage/uploads-panel";
import { Button, buttonStyles } from "@/components/ui/button";
import { DropZone } from "@/components/ui/drop-zone";
import { FileTrigger } from "@/components/ui/file-trigger";
import { Link } from "@/components/ui/link";
import { useRecordFolder } from "@/hooks/use-crm.ts";
import { useStorageList, useUploads } from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

const download = (node: StorageNode) => window.location.assign(storageFileUrl(node.id));

/** Finds or makes the record's folder, then uploads `files` into it. */
export function useRecordUpload(kind: "companies" | "deals", id: string, folderId: string | null) {
  const folder = useRecordFolder();
  const { upload } = useUploads();
  return async (files: File[]) => {
    if (!files.length) return;
    let parentId = folderId;
    try {
      parentId ??= (await folder.mutateAsync({ kind, id })).nodeId;
    } catch (error) {
      crmErrorToast(error, "The folder was not made");
      return;
    }
    upload(files, { place: { parentId } }, (name, error) =>
      storageErrorToast(error, `“${name}” was not uploaded`),
    );
  };
}

export function RecordFiles(props: {
  kind: "companies" | "deals";
  id: string;
  name: string;
  folderId: string | null;
}) {
  const send = useRecordUpload(props.kind, props.id, props.folderId);
  return (
    <DropZone
      bare
      aria-label={`Upload to ${props.name}`}
      className="relative flex min-h-80 w-full flex-col items-stretch justify-start gap-3"
      onDrop={(event) =>
        void Promise.all(
          event.items.flatMap((item) => (item.kind === "file" ? [item.getFile()] : [])),
        ).then(send)
      }
    >
      {props.folderId ? (
        <FolderFiles folderId={props.folderId} name={props.name} onFiles={send} />
      ) : (
        <Empty onFiles={send} />
      )}
      <UploadsPanel />
    </DropZone>
  );
}

function UploadButton(props: { onFiles: (files: File[]) => void }) {
  return (
    <FileTrigger allowsMultiple onSelect={(files) => props.onFiles([...(files ?? [])])}>
      <Button size="sm">
        <IconUpload />
        Upload
      </Button>
    </FileTrigger>
  );
}

function Empty(props: { onFiles: (files: File[]) => void }) {
  return (
    <EmptyState figure="drawer" title="No files yet">
      <UploadButton onFiles={props.onFiles} />
    </EmptyState>
  );
}

function FolderFiles(props: { folderId: string; name: string; onFiles: (files: File[]) => void }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const driveHref = (folderId: string) =>
    inWorkspace(`/files/shared/${encodeURIComponent(folderId)}`);
  const navigate = useNavigate();
  const list = useStorageList({ parentId: props.folderId });
  if (list.isPending) {
    return (
      <Skeleton loading label="Loading files" skeleton={<FileTableBones />}>
        {null}
      </Skeleton>
    );
  }
  if (list.isError) return <ListFailed retry={() => void list.refetch()} />;
  if (!list.nodes.length) return <Empty onFiles={props.onFiles} />;
  return (
    <>
      {/* Above the files they act on; an empty folder offers Upload in its empty state. */}
      <div className="flex items-center justify-end gap-1.5">
        <Link
          href={driveHref(props.folderId)}
          className={buttonStyles({ intent: "outline", size: "sm" })}
        >
          <IconFolder />
          Open in Drive
        </Link>
        <UploadButton onFiles={props.onFiles} />
      </div>
      {/* The table's page gutter, pulled back to this tab's own edges. */}
      <div className="-mx-5">
        <FileTable
          label={`Files of ${props.name}`}
          nodes={list.nodes}
          date={{ title: "Modified", of: (node) => node.updatedAt }}
          href={(node) => (node.kind === "folder" ? driveHref(node.id) : undefined)}
          onAction={download}
          menu={(node) =>
            node.kind === "file"
              ? [{ icon: IconDownload, label: "Download", onAction: () => download(node) }]
              : [
                  {
                    icon: IconFolder,
                    label: "Open in Drive",
                    onAction: () => void navigate({ href: driveHref(node.id) }),
                  },
                ]
          }
          loadMore={list.hasNextPage ? () => void list.fetchNextPage() : undefined}
          isLoadingMore={list.isFetchingNextPage}
        />
      </div>
    </>
  );
}
