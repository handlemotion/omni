import { useEffect } from "react";
import {
  IconCards,
  IconCheck,
  IconCircleX,
  IconFileZip,
  IconFolder,
  IconFolderMove,
  IconFolderPlus,
  IconNewDoc,
  IconRows,
  IconTrash,
  IconUpload,
} from "@/components/icons/central";
import type { ContextMenuEntry } from "@/components/ui/context-menu";
import type { NodeSelection } from "@/hooks/use-node-selection.ts";
import { useStorageView } from "@/hooks/use-storage-view.ts";
import { downloadZip } from "@/lib/download.ts";
import type { StoragePlace } from "@/lib/storage.ts";
import { pickedFromInput, type Picked } from "@/lib/storage-upload-tree.ts";
import type { FolderSource } from "./folder-view.tsx";
import { placeKey } from "./node-drag.tsx";
import { useBulkTrash } from "./selection-bar.tsx";

/**
 * Opens the system's file picker (or its folder picker) from a menu row, with no button to
 * wrap: a short-lived input the click opens, gone once the choice is made.
 */
export function pickFiles(onPicked: (files: File[] | Picked) => void, folder = false) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (folder) input.setAttribute("webkitdirectory", "");
  input.hidden = true;
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    input.remove();
    if (files.length) onPicked(folder ? pickedFromInput(files) : files);
  });
  input.addEventListener("cancel", () => input.remove());
  document.body.append(input);
  input.click();
}

let wantsFolder: string | null = null;
const folderPages = new Set<() => void>();

/** Asks the folder page for `place`, once it shows, to start a new folder (the sidebar's New folder). */
export function requestNewFolder(place: StoragePlace) {
  wantsFolder = placeKey(place);
  for (const page of folderPages) page();
}

/** On a folder page: starts the new folder asked for from elsewhere, on arrival or while open. */
export function useNewFolderRequest(place: StoragePlace, start: () => void) {
  const key = placeKey(place);
  useEffect(() => {
    const take = () => {
      if (wantsFolder !== key) return;
      wantsFolder = null;
      start();
    };
    take();
    folderPages.add(take);
    return () => {
      folderPages.delete(take);
    };
  }, [key, start]);
}

/**
 * A folder's right-click menus that aren't one item's: between the items (New, Upload, the
 * view, Select all) and on a selection of several (what its header bar offers).
 */
export function useFolderContextMenus(props: {
  source: FolderSource;
  selection: NodeSelection;
  onNewFolder: () => void;
  onNewDoc: (() => void) | undefined;
  onFiles: (files: File[] | Picked) => void;
  onMove: () => void;
}) {
  const { source, selection } = props;
  const [view, setView] = useStorageView();
  const trash = useBulkTrash(source.shareId);
  const write = source.canWrite;

  const background = () =>
    [
      write && { icon: IconFolderPlus, label: "New folder", onAction: props.onNewFolder },
      write && props.onNewDoc && { icon: IconNewDoc, label: "New doc", onAction: props.onNewDoc },
      "separator",
      write && {
        icon: IconUpload,
        label: "Upload files",
        onAction: () => pickFiles(props.onFiles),
      },
      write && {
        icon: IconFolder,
        label: "Upload folder",
        onAction: () => pickFiles(props.onFiles, true),
      },
      "separator",
      view === "cards"
        ? { icon: IconRows, label: "Show as rows", onAction: () => setView("rows") }
        : { icon: IconCards, label: "Show as cards", onAction: () => setView("cards") },
      source.list.nodes.length > 0 && {
        icon: IconCheck,
        label: "Select all",
        onAction: selection.selectAll,
      },
    ] satisfies ContextMenuEntry[];

  const selected = () => {
    const nodes = selection.nodes;
    return [
      source.download && {
        icon: IconFileZip,
        label: `Download ${nodes.length} items`,
        onAction: () =>
          downloadZip(
            nodes.map((n) => n.id),
            source.shareId,
          ),
      },
      write && { icon: IconFolderMove, label: "Move…", onAction: props.onMove },
      { icon: IconCircleX, label: "Clear selection", onAction: selection.clear },
      nodes.every(source.canTrash) && "separator",
      nodes.every(source.canTrash) && {
        icon: IconTrash,
        label: "Move to trash",
        danger: true,
        onAction: () => void trash.run(nodes).then(selection.clear),
      },
    ] satisfies ContextMenuEntry[];
  };

  return {
    background,
    selection: { ids: selection.ids, menu: selected },
  };
}
