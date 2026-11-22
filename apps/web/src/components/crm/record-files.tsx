import { driveOf } from "@/lib/storage.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconDownload, IconFolder, IconUnlink } from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { useCanTrash, useRowMenu, useStorageHref } from "@/components/storage/file-list.tsx";
import { FolderView, type FolderDialog } from "@/components/storage/folder-view.tsx";
import { storageErrorToast } from "@/components/storage/storage-errors.ts";
import { UploadsPanel } from "@/components/storage/uploads-panel.tsx";
import { Breadcrumbs, BreadcrumbsItem } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/ui/drop-zone";
import { FileTrigger } from "@/components/ui/file-trigger";
import { useRecordFolder } from "@/hooks/use-crm.ts";
import { useStorageList, useUploads } from "@/hooks/use-storage.ts";
import {
  crmFileLinksQuery,
  unlinkFileMutation,
  type CrmFileLink,
  type FileRecordKind,
} from "@/lib/crm-files.ts";
import { downloadFile, downloadZip } from "@/lib/download.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { AddFromDriveDialog } from "./add-from-drive.tsx";
import { crmErrorToast } from "./crm-errors.ts";

const fileUrl = (node: StorageNode) => storageFileUrl(node.id);
const download = (node: StorageNode) => downloadFile(fileUrl(node));

interface RecordProps {
  kind: FileRecordKind;
  id: string;
  name: string;
  folderId: string | null;
}

/** Finds or makes the record's folder, then uploads `files` into it. */
export function useRecordUpload(kind: FileRecordKind, id: string, folderId: string | null) {
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

/**
 * A company's or a deal's files, as Drive shows a folder: its own folder in Shared (uploads land
 * there, large ones resumable) and, at its top, the Drive files linked to it where they live
 * (`docs/spec/crm.md`, "Keep the files"). Preview, download, rename, move and trash are Drive's; a link is removed, never
 * trashed.
 */
export function RecordFiles(props: RecordProps) {
  const links = useQuery(crmFileLinksQuery(props.kind, props.id));
  const [adding, setAdding] = useState(false);
  const addFromDrive = (
    <Button intent="outline" size="sm" onPress={() => setAdding(true)}>
      Add from Drive
    </Button>
  );
  const linked = useMemo(
    () => new Set(links.data?.map((link) => link.node.id) ?? []),
    [links.data],
  );
  return (
    <div className="-mx-5 -mb-4 flex h-[calc(100svh-7.5rem)] min-h-96 flex-col">
      {props.folderId ? (
        <RecordFolder {...props} folderId={props.folderId} links={links} actions={addFromDrive} />
      ) : (
        <NoFolder {...props} actions={addFromDrive} />
      )}
      {adding && (
        <AddFromDriveDialog
          kind={props.kind}
          id={props.id}
          name={props.name}
          linked={linked}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function NoFolder(props: RecordProps & { actions: React.ReactNode }) {
  const send = useRecordUpload(props.kind, props.id, null);
  return (
    <DropZone
      bare
      aria-label={`Upload to ${props.name}`}
      className="relative flex min-h-0 flex-1 flex-col items-stretch justify-center"
      onDrop={(event) =>
        void Promise.all(
          event.items.flatMap((item) => (item.kind === "file" ? [item.getFile()] : [])),
        ).then(send)
      }
    >
      <EmptyState figure="drawer" title="No files yet">
        {props.actions}
        <FileTrigger allowsMultiple onSelect={(files) => void send([...(files ?? [])])}>
          <Button size="sm">Upload</Button>
        </FileTrigger>
      </EmptyState>
      <UploadsPanel />
    </DropZone>
  );
}

type LinksQuery = { data?: CrmFileLink[] | undefined; isPending: boolean; isError: boolean };

function RecordFolder(
  props: RecordProps & { folderId: string; links: LinksQuery; actions: React.ReactNode },
) {
  const { folder: sub } = useSearch({ strict: false }) as { folder?: string };
  const top = !sub || sub === props.folderId;
  const list = useStorageList({ parentId: top ? props.folderId : sub });
  const nav = useInFiles();
  const driveHref = useStorageHref();
  const canTrash = useCanTrash();
  const rowMenu = useRowMenu(canTrash);
  const unlink = useMutation(unlinkFileMutation(useQueryClient()));

  const linkedHere = useMemo(
    () =>
      top
        ? (props.links.data ?? [])
            .map((link) => link.node)
            .filter((node) => node.parentId !== props.folderId)
        : [],
    [top, props.links.data, props.folderId],
  );
  const isLink = useMemo(() => {
    const ids = new Set(linkedHere.map((node) => node.id));
    return (node: StorageNode) => ids.has(node.id);
  }, [linkedHere]);
  const nodes = useMemo(() => [...list.nodes, ...linkedHere], [list.nodes, linkedHere]);

  const menu = useCallback(
    (node: StorageNode, open: (dialog: FolderDialog) => void) => {
      if (!isLink(node)) return rowMenu(node, open);
      const items: SettingsRowMenuItem[] = [
        node.kind === "file"
          ? { icon: IconDownload, label: "Download", onAction: () => download(node) }
          : { icon: IconDownload, label: "Download", onAction: () => downloadZip([node.id]) },
        {
          icon: IconFolder,
          label: "Show in Drive",
          onAction: () => nav.go(driveHref(driveOf(node), node.parentId ?? undefined)),
        },
        {
          icon: IconUnlink,
          label: `Remove from ${props.name}`,
          onAction: () =>
            unlink.mutate(
              { kind: props.kind, id: props.id, nodeId: node.id },
              { onError: (error) => crmErrorToast(error, "It was not removed") },
            ),
        },
      ];
      return items;
    },
    [isLink, rowMenu, nav, driveHref, unlink, props.kind, props.id, props.name],
  );

  const path = list.folder?.path ?? [];
  const below = path.slice(path.findIndex((entry) => entry.id === props.folderId) + 1);
  if (list.isError && top) return <NoFolder {...props} />;
  return (
    <FolderView
      sidebar={false}
      actions={props.actions}
      title={(leaf) => (
        <Breadcrumbs aria-label="Folder" className="min-w-0">
          <BreadcrumbsItem onPress={() => nav.folder(undefined)}>Files</BreadcrumbsItem>
          {below.map((entry) => (
            <BreadcrumbsItem key={entry.id} onPress={() => nav.folder(entry.id)}>
              {entry.name}
            </BreadcrumbsItem>
          ))}
          {leaf !== undefined && <BreadcrumbsItem>{leaf}</BreadcrumbsItem>}
        </Breadcrumbs>
      )}
      source={{
        label: below.at(-1)?.name ?? props.name,
        place: { parentId: top ? props.folderId : sub },
        canWrite: true,
        list: {
          ...list,
          nodes,
          isPending: list.isPending || (top && props.links.isPending),
        },
        folderHref: (node) =>
          isLink(node) ? driveHref(driveOf(node), node.id) : nav.href(node.id),
        fileUrl,
        download,
        menu,
        canTrash: (node) => !isLink(node) && canTrash(node),
        move: { kind: "member", space: "shared", path },
        empty: { title: "No files yet" },
      }}
    />
  );
}

function useInFiles() {
  const router = useRouter();
  return useMemo(() => {
    const at = (folder: string | undefined) =>
      router.buildLocation({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          folder,
          file: undefined,
          comments: undefined,
        })) as never,
      }).href;
    return {
      href: (folder: string) => at(folder),
      folder: (folder: string | undefined) => void router.history.push(at(folder)),
      go: (href: string) => void router.history.push(href),
    };
  }, [router]);
}
