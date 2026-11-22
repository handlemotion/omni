import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  IconArrowUpRight,
  IconChevronDown,
  IconChevronRight,
  IconFileZip,
  IconFolder,
  IconFolderPlus,
  IconNewDoc,
  IconPlus,
  IconSettings,
  IconSparkle,
  IconTrash,
  IconUpload,
  IconUserAdd,
  IconUsers,
} from "@/components/icons/central";
import { contextMenuProps, type ContextMenuEntry } from "@/components/ui/context-menu";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { useNewDoc } from "@/hooks/use-new-doc.ts";
import { useTeamspaces, useTrashNode, useUploads } from "@/hooks/use-storage.ts";
import { downloadZip } from "@/lib/download.ts";
import type { DriveRoot, StorageNode, StoragePlace } from "@/lib/storage.ts";
import type { Picked } from "@/lib/storage-upload-tree.ts";
import { useCanTrash } from "./file-list.tsx";
import { pickFiles, requestNewFolder } from "./folder-context.tsx";
import { FolderIconDialog } from "./folder-icons.tsx";
import { ShareDialog } from "./share-dialog.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { TeamspaceSettingsDialog } from "./teamspace-dialogs.tsx";

type Expand = { value: boolean; toggle: () => void } | undefined;

function useMakeIn(place: StoragePlace, path: string) {
  const navigate = useNavigate();
  const { href } = useWorkspacePaths();
  const { upload } = useUploads();
  const doc = useNewDoc(place, undefined, (node) => {
    void navigate({ href: href(`${path}?file=${encodeURIComponent(node.id)}`) });
  });
  const send = (files: File[] | Picked) =>
    upload(files, { place }, (name, error) =>
      storageErrorToast(error, `“${name}” was not uploaded`),
    );
  return {
    open: () => void navigate({ href: href(path) }),
    entries: [
      {
        icon: IconFolderPlus,
        label: "New folder",
        onAction: () => {
          requestNewFolder(place);
          void navigate({ href: href(path) });
        },
      },
      {
        icon: IconNewDoc,
        label: "New doc",
        disabled: doc.isPending,
        onAction: () =>
          doc.mutate(undefined, {
            onError: (error) => storageErrorToast(error, "The doc was not made"),
          }),
      },
      { icon: IconUpload, label: "Upload files", onAction: () => pickFiles(send) },
      { icon: IconFolder, label: "Upload folder", onAction: () => pickFiles(send, true) },
    ] satisfies ContextMenuEntry[],
  };
}

const expandEntry = (expand: Expand) =>
  !!expand && {
    icon: expand.value ? IconChevronDown : IconChevronRight,
    label: expand.value ? "Collapse" : "Expand",
    onAction: expand.toggle,
  };

/**
 * A drive's row in the sidebar (a space, Personal, Team): open it, make or upload into it, and,
 * for a space, its settings. Spread `props` on the row; render `dialogs` beside it.
 */
export function useDriveRowMenu(drive: DriveRoot, path: string, expand: Expand) {
  const make = useMakeIn(drive, path);
  const { teamspaces } = useTeamspaces();
  const teamspace =
    "teamspaceId" in drive ? teamspaces.find((each) => each.id === drive.teamspaceId) : undefined;
  const [settings, setSettings] = useState(false);
  const entries = () =>
    [
      { icon: IconArrowUpRight, label: "Open", onAction: make.open },
      expandEntry(expand),
      "separator",
      ...make.entries,
      teamspace && "separator",
      teamspace && {
        icon: IconSettings,
        label: "Space settings",
        onAction: () => setSettings(true),
      },
    ] satisfies ContextMenuEntry[];
  return {
    props: contextMenuProps(entries),
    dialogs: settings && teamspace && (
      <TeamspaceSettingsDialog teamspace={teamspace} onClose={() => setSettings(false)} />
    ),
  };
}

/** A folder's row in the sidebar: what its row in the folder offers that needs no inline edit. */
export function useFolderRowMenu(node: StorageNode, path: string, expand: Expand) {
  const make = useMakeIn({ parentId: node.id }, path);
  const canTrash = useCanTrash();
  const trash = useTrashNode();
  const [dialog, setDialog] = useState<"share" | "icon" | null>(null);
  const entries = () =>
    [
      { icon: IconArrowUpRight, label: "Open", onAction: make.open },
      expandEntry(expand),
      "separator",
      ...make.entries,
      "separator",
      { icon: IconUserAdd, label: "Share", onAction: () => setDialog("share") },
      node.parentId === null && {
        icon: IconSparkle,
        label: "Change icon",
        onAction: () => setDialog("icon"),
      },
      { icon: IconFileZip, label: "Download", onAction: () => downloadZip([node.id]) },
      canTrash(node) && "separator",
      canTrash(node) && {
        icon: IconTrash,
        label: "Move to trash",
        danger: true,
        onAction: () =>
          trash.mutate(
            { id: node.id },
            { onError: (error) => storageErrorToast(error, "It was not moved to Trash") },
          ),
      },
    ] satisfies ContextMenuEntry[];
  const close = () => setDialog(null);
  return {
    props: contextMenuProps(entries, `Actions for ${node.name}`),
    dialogs:
      dialog === "share" ? (
        <ShareDialog node={node} onClose={close} />
      ) : dialog === "icon" ? (
        <FolderIconDialog node={node} onClose={close} />
      ) : null,
  };
}

/** Drive's sidebar between its rows: New space, and Browse spaces when there are more to join. */
export function SpacesArea(props: {
  onNewSpace: () => void;
  onBrowse: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className="contents"
      {...contextMenuProps(() => [
        { icon: IconPlus, label: "New space", onAction: props.onNewSpace },
        props.onBrowse && { icon: IconUsers, label: "Browse spaces", onAction: props.onBrowse },
      ])}
    >
      {props.children}
    </div>
  );
}
