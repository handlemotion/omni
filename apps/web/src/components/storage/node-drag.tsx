import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DropItem, DropOperation } from "react-aria-components";
import { useUploads } from "@/hooks/use-storage.ts";
import { compareNodes } from "@/lib/storage-cache.ts";
import { pickedFromDropItems, pickedFromTransfer } from "@/lib/storage-upload-tree.ts";
import {
  driveKey,
  driveOf,
  type DriveRoot,
  type StorageNode,
  type StoragePlace,
} from "@/lib/storage.ts";
import { useDriveDrag } from "./drive-drag-state.ts";
import { storageErrorToast } from "./storage-errors.ts";

/** A folder a drag held over would drop into: the drop zone's tint, and its edge. */
export const DROP_TARGET =
  "data-drive-target:bg-primary/10 data-drive-target:inset-ring data-drive-target:inset-ring-primary";

/** A folder card a drag would drop into: its preview alone, as Finder marks a folder's icon. */
export const CARD_DROP_TARGET =
  "data-drive-target:bg-transparent! data-drive-target:**:data-[slot=folder-art]:outline-2 data-drive-target:**:data-[slot=folder-art]:outline-offset-2 data-drive-target:**:data-[slot=folder-art]:outline-primary";

/**
 * Where a lifted item was: its content hidden and a dashed edge where its hover fill sits, in the
 * same rounding; while it lands, nothing.
 */
export const LIFTED =
  "data-lifted:bg-transparent! data-lifted:*:invisible data-[lifted=origin]:outline-1 data-[lifted=origin]:-outline-offset-1 data-[lifted=origin]:outline-dashed data-[lifted=origin]:outline-border";

/** The room a drag opens where its item will land: a dashed edge in the brand's blue, tinted. */
export const GAP =
  "rounded-lg bg-primary/5 outline-1 -outline-offset-1 outline-dashed outline-primary";

/** How an item is drawn, so its lifted copy keeps the shape. */
export type Look = "card" | "row" | "tree";

/** A node being dragged, and the door it moves through (a shared link's, or the member's). */
export interface Dragged {
  node: StorageNode;
  shareId?: string | undefined;
}

/** What a drag picked up: the node, and how the item it lifted from was drawn. */
export interface DragSource extends Dragged {
  look: Look;
}

/** Where a drop goes: a folder or a drive's top, through a door; `within` its known ancestors. */
export interface DropPlace {
  place: StoragePlace;
  /** The drive a folder is in, where it is known; a drive's top names its own. */
  drive?: DriveRoot | undefined;
  shareId?: string | undefined;
  canWrite: boolean;
  /** Folders this place is inside, so a folder is never offered a drop into itself. */
  within?: string[] | undefined;
}

/** What a drop target takes: into `to`; held at its top or bottom edge, `beside`, its parent. */
export interface DropData {
  to: DropPlace;
  /** A folder highlights while a drop would go into it; a page or list does not. */
  folder: boolean;
  beside?: DropPlace | undefined;
}

/** A place's key: two places are one when their keys match. */
export const placeKey = (place: StoragePlace) =>
  "parentId" in place ? `folder:${place.parentId}` : `drive:${driveKey(place)}`;

/** Whether `dragged` can move to `to`: through the same door, not into itself, not where it is. */
export function canMove(dragged: Dragged, to: DropPlace) {
  const { node } = dragged;
  if (!to.canWrite || (dragged.shareId ?? null) !== (to.shareId ?? null)) return false;
  const into = "parentId" in to.place ? to.place.parentId : null;
  if (into === node.id || to.within?.includes(node.id)) return false;
  const drive = "parentId" in to.place ? to.drive : to.place;
  return (
    into !== node.parentId ||
    (into === null && !!drive && driveKey(drive) !== driveKey(driveOf(node)))
  );
}

/**
 * Where a list showing `place` opens its gap for the drag: the index the dragged node lands at
 * among `nodes`, in the Worker's order; none unless it lands here and is not here already.
 */
export function useGapAt(
  place: StoragePlace | null | undefined,
  nodes: StorageNode[],
  kind: StorageNode["kind"],
) {
  const { source, aim } = useDriveDrag();
  if (!place || !source || !aim || placeKey(aim.to.place) !== placeKey(place)) return null;
  const { node } = source;
  if (node.kind !== kind || nodes.some((each) => each.id === node.id)) return null;
  const at = nodes.findIndex((each) => compareNodes(node, each) < 0);
  return at < 0 ? nodes.length : at;
}

/**
 * An item that lifts (given `source`) and takes drops (given `drop`). `id` is unique on the page:
 * the same folder can be drawn on the page and in the sidebar.
 */
export function useNodeDrag(id: string, source: DragSource | null, drop: DropData | null) {
  const drag = useDraggable({ id, data: source ?? undefined, disabled: !source });
  const target = useDroppable({ id, data: drop ?? undefined, disabled: !drop });
  const { setNodeRef: dragRef } = drag;
  const { setNodeRef: dropRef } = target;
  const ref = useCallback(
    (element: HTMLElement | null) => {
      dragRef(element);
      dropRef(element);
    },
    [dragRef, dropRef],
  );
  const state = useDriveDrag();
  const lifted = state.from === id ? state.phase : undefined;
  return {
    ref,
    props: {
      onPointerDown: drag.listeners?.onPointerDown as React.PointerEventHandler | undefined,
      "data-drive-drag": source ? "" : undefined,
      "data-lifted": lifted,
      "data-drive-target": state.aim?.over === id || undefined,
    },
  };
}

/** A surface's drags: its door, and the folder it shows (none for Search's results). */
export interface NodeDrag {
  door: { shareId?: string | undefined; canWrite: boolean };
  here: DropPlace | null;
}

/** What `node` lifts as, and takes, on a surface whose drags are `drag`. */
export function useSurfaceDrag(node: StorageNode, look: Look, drag: NodeDrag | undefined) {
  const door = drag?.door;
  const source = useMemo<DragSource | null>(
    () => (door?.canWrite ? { node, look, shareId: door.shareId } : null),
    [node, look, door?.canWrite, door?.shareId],
  );
  const drop = useMemo<DropData | null>(
    () =>
      door && node.kind === "folder"
        ? { to: { ...door, place: { parentId: node.id }, drive: driveOf(node) }, folder: true }
        : null,
    [node.id, node.kind, node.space, node.teamspaceId, door],
  );
  const lift = useNodeDrag(`${look}:${node.id}`, source, drop);
  const files = useFilesDropOn(drop?.to ?? null);
  const { ref: liftRef } = lift;
  const { ref: filesRef } = files;
  const ref = useCallback(
    (element: HTMLElement | null) => {
      liftRef(element);
      filesRef(element);
    },
    [liftRef, filesRef],
  );
  const target = lift.props["data-drive-target"] ?? files.over ?? undefined;
  return { ref, props: { ...lift.props, "data-drive-target": target } };
}

function useFilesDropOn(to: DropPlace | null) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [over, setOver] = useState(false);
  const { upload } = useUploads();
  useEffect(() => {
    if (!element || !to?.canWrite) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const hover = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setOver(false);
      void pickedFromTransfer(event.dataTransfer).then((picked) =>
        upload(picked, { place: to.place, shareId: to.shareId }, (name, error) =>
          storageErrorToast(error, `“${name}” was not uploaded`),
        ),
      );
    };
    element.addEventListener("dragenter", enter);
    element.addEventListener("dragleave", leave);
    element.addEventListener("dragover", hover);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("dragenter", enter);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("dragover", hover);
      element.removeEventListener("drop", drop);
    };
  }, [element, to, upload]);
  return { ref: setElement, over: over || undefined };
}

/** A page or list as a drop target: a drop on it, not on one of its folders, lands in `to`. */
export function useRoomDrop(id: string, to: DropPlace | null) {
  const data = useMemo<DropData | undefined>(() => (to ? { to, folder: false } : undefined), [to]);
  return useDroppable({ id, data, disabled: !to }).setNodeRef;
}

/** What a drop of the computer's files at `to` does: copies them there, if it may be written. */
export const dropOperation = (to: DropPlace) => {
  const result: DropOperation = to.canWrite ? "copy" : "cancel";
  return result;
};

/** Drops of the computer's files and folders at a place: they upload there, folders and all. */
export function useDropInto() {
  const { upload } = useUploads();
  return useMemo(
    () => async (to: DropPlace, items: DropItem[]) => {
      if (!to.canWrite) return;
      const picked = await pickedFromDropItems(items);
      upload(picked, { place: to.place, shareId: to.shareId }, (name, error) =>
        storageErrorToast(error, `“${name}” was not uploaded`),
      );
    },
    [upload],
  );
}
