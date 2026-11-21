import { useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  IconClock3,
  IconComment,
  IconSignature,
  IconDownload,
  IconFilePdf,
  IconFileText,
  IconFolderMove,
  IconMarkdown,
  IconNewDoc,
  IconPencil,
  IconSparkle,
  IconTrash,
  IconUserAdd,
} from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { useMember } from "@/hooks/use-session.ts";
import { canConvertToDoc, useConvertToDoc } from "@/hooks/use-convert-doc.ts";
import { useExportDoc } from "@/hooks/use-export-doc.ts";
import { useStorageList, useTrashNode } from "@/hooks/use-storage.ts";
import type { StorageNode, StoragePlace, StorageSpace } from "@/lib/storage.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { FolderCrumbs } from "./folder-crumbs.tsx";
import { FolderView, type FolderDialog } from "./folder-view.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { SPACE_LABEL, SPACE_PATH } from "./storage-nav.tsx";
import { workspaceHref } from "@/lib/workspaces.ts";
import { downloadFile, downloadZip } from "@/lib/download.ts";
import { isOmniDoc } from "@omni/docs/file";
import { fileType } from "@/lib/file-kind.ts";
import type { DocExport } from "./editor/export-doc.ts";

const EMPTY = {
  personal: { title: "No files yet", description: "Files you add here are yours alone." },
  shared: { title: "No files yet", description: "Everyone in the workspace sees files here." },
  folder: { title: "This folder is empty", description: "Drop files here or upload them." },
} as const;

/** A link inside Storage, keeping the mailbox the switcher shows for the way back to mail. */
export function useStorageHref() {
  const href = useOptionalStorageHref();
  if (!href) throw new Error("useStorageHref outside a workspace route");
  return href;
}

/** Where a space or folder opens in this workspace; null on a page outside one (a shared link). */
export function useOptionalStorageHref() {
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const { workspace } = useParams({ strict: false }) as { workspace?: string };
  return useMemo(
    () =>
      workspace
        ? (space: StorageSpace, folderId?: string) =>
            workspaceHref(
              workspace,
              `${SPACE_PATH[space]}${folderId ? `/${encodeURIComponent(folderId)}` : ""}${mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : ""}`,
            )
        : null,
    [mailbox, workspace],
  );
}

export function FileList({ space, folderId }: { space: StorageSpace; folderId?: string }) {
  const place: StoragePlace = folderId ? { parentId: folderId } : { space };
  const list = useStorageList(place);
  const href = useStorageHref();
  const canTrash = useCanTrash();
  const menu = useRowMenu(canTrash);
  const path = list.folder?.path ?? [];
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
        canTrash,
        move: { kind: "member", space, path },
        empty: folderId ? EMPTY.folder : EMPTY[space],
      }}
    />
  );
}

const fileUrl = (node: StorageNode) => storageFileUrl(node.id);
const download = (node: StorageNode) => downloadFile(fileUrl(node));

type ExportDoc = (node: StorageNode, format: DocExport) => void;

const docExports = (node: StorageNode, exportAs: ExportDoc) =>
  node.kind === "file" && fileType(node.name, node.mimeType).language === "markdown"
    ? [
        { icon: IconFilePdf, label: "Export as PDF", onAction: () => exportAs(node, "pdf") },
        { icon: IconFileText, label: "Export as Word", onAction: () => exportAs(node, "docx") },
        ...(isOmniDoc(node.mimeType)
          ? [
              {
                icon: IconMarkdown,
                label: "Export as Markdown",
                onAction: () => exportAs(node, "md"),
              },
            ]
          : []),
      ]
    : [];

export function useCanTrash() {
  const { member } = useMember();
  const manager = /\b(owner|admin)\b/.test(member.role);
  return useCallback(
    (node: StorageNode) =>
      node.space === "personal" || manager || node.createdByMemberId === member.id,
    [manager, member.id],
  );
}

export function useRowMenu(canTrash: (node: StorageNode) => boolean) {
  const trash = useTrashNode();
  const trashNode = trash.mutate;
  const exportDoc = useExportDoc().mutate;
  const convert = useConvertToDoc().run;
  const exportAs = useCallback<ExportDoc>(
    (node, format) =>
      exportDoc(
        { node, format },
        { onError: (error) => storageErrorToast(error, `“${node.name}” was not exported`) },
      ),
    [exportDoc],
  );
  return useCallback(
    (node: StorageNode, open: (dialog: FolderDialog) => void) => {
      const result: SettingsRowMenuItem[] = [
        ...(isOmniDoc(node.mimeType)
          ? []
          : [
              {
                icon: IconDownload,
                label: "Download",
                onAction: () => (node.kind === "file" ? download(node) : downloadZip([node.id])),
              },
            ]),
        ...docExports(node, exportAs),
        ...(canConvertToDoc(node)
          ? [
              {
                icon: IconNewDoc,
                label: "Convert to Omni doc",
                onAction: () => void convert([node]),
              },
            ]
          : []),
        { icon: IconUserAdd, label: "Share", onAction: () => open({ dialog: "share", node }) },
        { icon: IconPencil, label: "Rename", onAction: () => open({ dialog: "rename", node }) },
        ...(node.kind === "folder" && node.parentId === null
          ? [
              {
                icon: IconSparkle,
                label: "Change icon",
                onAction: () => open({ dialog: "icon", node }),
              },
            ]
          : []),
        { icon: IconFolderMove, label: "Move", onAction: () => open({ dialog: "move", node }) },
        ...(node.kind === "file"
          ? [
              {
                icon: IconComment,
                label: "Comments",
                onAction: () => open({ dialog: "comments", node }),
              },
              {
                icon: IconClock3,
                label: "Versions",
                onAction: () => open({ dialog: "versions", node }),
              },
            ]
          : []),
        ...(node.mimeType === "application/pdf"
          ? [
              {
                icon: IconSignature,
                label: "Signatures",
                onAction: () => open({ dialog: "signatures", node }),
              },
            ]
          : []),
        ...(canTrash(node)
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
      ];
      return result;
    },
    [canTrash, trashNode, exportAs],
  );
}
