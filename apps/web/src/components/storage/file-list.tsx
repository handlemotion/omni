// A folder's page in My files or Shared (ADR 0034 decision 8), through the member's door: its
// place in the title, and each row's Download, Share, Rename, Move and Move to trash.
import { useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  IconDownload,
  IconFolderMove,
  IconPencil,
  IconTrash,
  IconUserAdd,
} from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { useMember } from "@/hooks/use-session.ts";
import { useStorageList, useTrashNode } from "@/hooks/use-storage.ts";
import type { StorageNode, StoragePlace, StorageSpace } from "@/lib/storage.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { FolderCrumbs } from "./folder-crumbs.tsx";
import { FolderView, type FolderDialog } from "./folder-view.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { SPACE_LABEL, SPACE_PATH } from "./storage-nav.tsx";

const EMPTY = {
  personal: { title: "No files yet", description: "Files you add here are yours alone." },
  shared: { title: "No files yet", description: "Everyone in the workspace sees files here." },
  folder: { title: "This folder is empty", description: "Drop files here or upload them." },
} as const;

/** A link inside Storage, keeping the mailbox the switcher shows for the way back to mail. */
function useStorageHref() {
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  return useCallback(
    (space: StorageSpace, folderId?: string) =>
      `${SPACE_PATH[space]}${folderId ? `/${encodeURIComponent(folderId)}` : ""}${mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : ""}`,
    [mailbox],
  );
}

export function FileList({ space, folderId }: { space: StorageSpace; folderId?: string }) {
  const place: StoragePlace = folderId ? { parentId: folderId } : { space };
  const list = useStorageList(place);
  const href = useStorageHref();
  const menu = useRowMenu();
  const path = list.folder?.path ?? [];
  // Stable, so the memoized table and grid render only when their rows change.
  const folderHref = useMemo(() => (node: StorageNode) => href(node.space, node.id), [href]);
  return (
    <FolderView
      title={
        <FolderCrumbs
          top={{ name: SPACE_LABEL[space], href: href(space) }}
          path={path}
          href={(id) => href(space, id)}
        />
      }
      source={{
        label: path.at(-1)?.name ?? SPACE_LABEL[space],
        place,
        canWrite: true,
        list,
        folderHref,
        fileUrl,
        download,
        menu,
        move: { kind: "member", space, path },
        empty: folderId ? EMPTY.folder : EMPTY[space],
      }}
    />
  );
}

/** Where a file's bytes are: Download, and the preview's read of them (ADR 0040). */
const fileUrl = (node: StorageNode) => storageFileUrl(node.id);
const download = (node: StorageNode) => window.location.assign(fileUrl(node));

/** A row's actions. In Shared, Trash is for whoever added the item, owners and admins. */
function useRowMenu() {
  const { member } = useMember();
  const trash = useTrashNode();
  const manager = /\b(owner|admin)\b/.test(member.role);
  const trashNode = trash.mutate;
  return useCallback(
    (node: StorageNode, open: (dialog: FolderDialog) => void): SettingsRowMenuItem[] => [
      ...(node.kind === "file"
        ? [{ icon: IconDownload, label: "Download", onAction: () => download(node) }]
        : []),
      { icon: IconUserAdd, label: "Share", onAction: () => open({ dialog: "share", node }) },
      { icon: IconPencil, label: "Rename", onAction: () => open({ dialog: "rename", node }) },
      { icon: IconFolderMove, label: "Move", onAction: () => open({ dialog: "move", node }) },
      ...(node.space === "personal" || manager || node.createdByMemberId === member.id
        ? [
            {
              icon: IconTrash,
              label: "Move to trash",
              danger: true,
              onAction: () =>
                trashNode(
                  { id: node.id },
                  { onError: (error) => storageErrorToast(error, "It was not moved to Trash") },
                ),
            },
          ]
        : []),
    ],
    [manager, member.id, trashNode],
  );
}
