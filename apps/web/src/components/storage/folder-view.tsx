// A folder's page, whichever door it is opened through (a member's My files or Shared, or a
// shared link): the table, files dropped anywhere on it uploaded here, the upload actions for
// whoever may write, and the dialogs its rows open.
import { useState, type ReactNode } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconFolderPlus, IconUpload } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/ui/drop-zone";
import { FileTrigger } from "@/components/ui/file-trigger";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { useUploads } from "@/hooks/use-storage.ts";
import type { StorageNode, StoragePlace } from "@/lib/storage.ts";
import { MoveDialog, NewFolderDialog, RenameDialog, type MoveScope } from "./file-dialogs.tsx";
import { FileTable, FileTableBones } from "./file-table.tsx";
import { ShareDialog } from "./share-dialog.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { StorageFrame } from "./storage-frame.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";

export type FolderDialog =
  | { dialog: "new" }
  | { dialog: "rename" | "move" | "share"; node: StorageNode }
  | null;

export interface FolderSource {
  /** The folder's own name, for the table and the drop target. */
  label: string;
  place: StoragePlace;
  /** Through a shared link's door; else the member's. */
  shareId?: string | undefined;
  /** New folder, Upload and drops, and the rows' changes. */
  canWrite: boolean;
  list: {
    nodes: StorageNode[];
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
    hasNextPage: boolean;
    fetchNextPage: () => unknown;
    isFetchingNextPage: boolean;
  };
  /** Where a folder's row leads. */
  folderHref: (node: StorageNode) => string;
  download: (node: StorageNode) => void;
  /** The rows' actions, given the way to open this page's dialogs. */
  menu: (node: StorageNode, open: (dialog: FolderDialog) => void) => SettingsRowMenuItem[];
  move: MoveScope;
  empty: { title: string; description?: string };
}

export function FolderView(props: {
  title: ReactNode;
  /** False outside the app shell. */
  sidebar?: boolean;
  source: FolderSource;
}) {
  const { source } = props;
  const { upload } = useUploads();
  const [open, setOpen] = useState<FolderDialog>(null);
  const close = () => setOpen(null);
  const send = (files: File[]) =>
    files.length > 0 &&
    upload(files, { place: source.place, shareId: source.shareId }, (name, error) =>
      storageErrorToast(error, `“${name}” was not uploaded`),
    );
  const actions = { onNewFolder: () => setOpen({ dialog: "new" }), onFiles: send };

  return (
    <StorageFrame
      title={props.title}
      sidebar={props.sidebar}
      actions={source.canWrite && <HeaderActions {...actions} />}
    >
      {/* The whole page under the header takes a drop, the empty folder included. */}
      <DropZone
        bare
        aria-label={`Upload to ${source.label}`}
        isDisabled={!source.canWrite}
        className="min-h-0 flex-1 overflow-y-auto"
        onDrop={(event) =>
          void Promise.all(
            event.items.flatMap((item) => (item.kind === "file" ? [item.getFile()] : [])),
          ).then(send)
        }
      >
        <Body source={source} open={setOpen} actions={actions} />
      </DropZone>
      <UploadsPanel />
      {open?.dialog === "new" && (
        <NewFolderDialog place={source.place} shareId={source.shareId} onClose={close} />
      )}
      {open?.dialog === "rename" && (
        <RenameDialog node={open.node} shareId={source.shareId} onClose={close} />
      )}
      {open?.dialog === "move" && (
        <MoveDialog node={open.node} scope={source.move} onClose={close} />
      )}
      {open?.dialog === "share" && <ShareDialog node={open.node} onClose={close} />}
    </StorageFrame>
  );
}

interface Actions {
  onNewFolder: () => void;
  onFiles: (files: File[]) => void;
}

function Body(props: {
  source: FolderSource;
  open: (dialog: FolderDialog) => void;
  actions: Actions;
}) {
  const { source } = props;
  const { list } = source;
  if (list.isPending) {
    return (
      <Skeleton loading label="Loading files" skeleton={<FileTableBones />}>
        {null}
      </Skeleton>
    );
  }
  if (list.isError) {
    return (
      <Centered>
        <ListFailed retry={() => void list.refetch()} />
      </Centered>
    );
  }
  if (!list.nodes.length) {
    return (
      <Centered>
        <EmptyState figure="drawer" {...source.empty}>
          {source.canWrite && <EmptyActions {...props.actions} />}
        </EmptyState>
      </Centered>
    );
  }
  return (
    <FileTable
      label={source.label}
      nodes={list.nodes}
      date={{ title: "Modified", of: (node) => node.updatedAt }}
      href={(node) => (node.kind === "folder" ? source.folderHref(node) : undefined)}
      onAction={source.download}
      menu={(node) => source.menu(node, props.open)}
      loadMore={list.hasNextPage ? () => void list.fetchNextPage() : undefined}
      isLoadingMore={list.isFetchingNextPage}
    />
  );
}

/** Fills the page under the header, so an empty state sits where the mail lists' do. */
function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col">{children}</div>;
}

/** An empty folder's way on, as the mail lists' empty states offer theirs: Upload first. */
function EmptyActions(props: Actions) {
  return (
    <>
      <FileTrigger allowsMultiple onSelect={(files) => props.onFiles([...(files ?? [])])}>
        <Button size="sm">Upload</Button>
      </FileTrigger>
      <Button size="sm" intent="outline" onPress={props.onNewFolder}>
        New folder
      </Button>
    </>
  );
}

/** New folder and Upload; on a phone their icons alone, so the breadcrumbs keep the room. */
function HeaderActions(props: Actions) {
  const phone = useIsMobile();
  return (
    <>
      <Button
        intent="outline"
        size={phone ? "sq-sm" : "sm"}
        aria-label={phone ? "New folder" : undefined}
        onPress={props.onNewFolder}
      >
        <IconFolderPlus />
        {!phone && "New folder"}
      </Button>
      <FileTrigger allowsMultiple onSelect={(files) => props.onFiles([...(files ?? [])])}>
        <Button size={phone ? "sq-sm" : "sm"} aria-label={phone ? "Upload" : undefined}>
          <IconUpload />
          {!phone && "Upload"}
        </Button>
      </FileTrigger>
    </>
  );
}
