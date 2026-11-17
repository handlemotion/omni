// Drag and drop in Drive: files and folders move by dragging them onto a folder, wherever either
// is drawn. A folder page's cards and rows drag, and take a drop on a folder or on the page itself
// (the folder it shows); the sidebar's clusters and their folders drag too, and they and the
// Team and Personal groups take drops. Files dragged in from the computer upload wherever they are
// dropped. React Aria's drag and drop, the collections' own: native drags (so they cross from the
// page to the sidebar), a keyboard alternative, and what a screen reader hears.
//
// A drag carries its nodes as JSON under `NODE_TYPE`, read at the drop. While one of ours is under
// way its nodes are kept here too: a drop target is asked whether it takes a drag before the drop,
// and the browser only shows a drag's data at the drop.
import { useMemo } from "react";
import type { DropItem, DropOperation, Key } from "react-aria-components";
import { useDragAndDrop } from "react-aria-components/useDragAndDrop";
import { isFileDropItem, isTextDropItem } from "react-aria-components/useDrop";
import { z } from "zod";
import { useChangeNode, useUploads } from "@/hooks/use-storage.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode, StoragePlace, StorageSpace } from "@/lib/storage.ts";
import { FileTile } from "./file-glyph.tsx";
import { storageErrorToast } from "./storage-errors.ts";

/** A folder a drag hovers over, when it takes the drop: the drop zone's tint, and its edge. */
export const DROP_TARGET =
  "drop-target:bg-primary/10 drop-target:inset-ring drop-target:inset-ring-primary";

/** Our drags' data type: only Drive reads it. */
const NODE_TYPE = "application/x-omni-storage-node";

const draggedSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["file", "folder"]),
  space: z.enum(["personal", "shared"]),
  parentId: z.string().nullable(),
  mimeType: z.string().nullable(),
  shareId: z.string().optional(),
});

/** A node being dragged, and the door it moves through (a shared link's, or the member's). */
export type Dragged = z.infer<typeof draggedSchema>;

/** Where a drop goes: a folder or a space's top, through a door; `within` its known ancestors. */
export interface DropPlace {
  place: StoragePlace;
  /** The space a top-level place is in; a folder's, where it is known. */
  space?: StorageSpace | undefined;
  shareId?: string | undefined;
  canWrite: boolean;
  /** Folders this place is inside, so a folder is never offered a drop into itself. */
  within?: string[] | undefined;
}

/** A drag's item: its data by type, as React Aria's `DragItem` is. */
type DragItem = Record<string, string>;

let dragging: Dragged[] = [];

export const startDrag = (nodes: Dragged[]) => {
  dragging = nodes;
};
export const endDrag = () => {
  dragging = [];
};

export function draggedOf(node: StorageNode, shareId: string | undefined): Dragged {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    space: node.space,
    parentId: node.parentId,
    mimeType: node.mimeType,
    ...(shareId ? { shareId } : {}),
  };
}

/** The drag's items: ours, and its name as plain text for anything else it is dropped on. */
export const dragItems = (nodes: Dragged[]): DragItem[] =>
  nodes.map((node) => ({ [NODE_TYPE]: JSON.stringify(node), "text/plain": node.name }));

/** Whether `node` can move to `to`: through the same door, not into itself, not where it is. */
function canMove(node: Dragged, to: DropPlace) {
  if (!to.canWrite || (node.shareId ?? null) !== (to.shareId ?? null)) return false;
  const into = "parentId" in to.place ? to.place.parentId : null;
  if (into === node.id || to.within?.includes(node.id)) return false;
  const space = "space" in to.place ? to.place.space : to.space;
  return into !== node.parentId || (into === null && space !== node.space);
}

/**
 * What a drop at `to` would do: move our drag there, upload files from the computer, or nothing.
 * Anything not ours is taken for files; a drop without any uploads nothing.
 */
export function dropOperation(to: DropPlace): DropOperation {
  if (!dragging.length) return to.canWrite ? "copy" : "cancel";
  return dragging.every((node) => canMove(node, to)) ? "move" : "cancel";
}

/** Our nodes in a drop's items; none for a drop from anywhere else. */
async function nodesIn(items: DropItem[]) {
  const texts = items.filter((item) => isTextDropItem(item) && item.types.has(NODE_TYPE));
  const read = await Promise.all(
    texts.map(async (item) => {
      if (!isTextDropItem(item)) return null;
      const parsed = draggedSchema.safeParse(JSON.parse(await item.getText(NODE_TYPE)));
      return parsed.success ? parsed.data : null;
    }),
  );
  return read.filter((node) => node !== null);
}

/** Drops at a place: our nodes move there, the computer's files upload there. */
export function useDropInto() {
  const change = useChangeNode();
  const { upload } = useUploads();
  const move = change.mutateAsync;
  return useMemo(
    () => async (to: DropPlace, items: DropItem[]) => {
      const nodes = await nodesIn(items);
      if (nodes.length) {
        for (const node of nodes.filter((each) => canMove(each, to))) {
          await move({
            id: node.id,
            place: to.place,
            ...(to.shareId ? { shareId: to.shareId } : {}),
          }).catch((error: unknown) => storageErrorToast(error, `“${node.name}” was not moved`));
        }
        return;
      }
      if (!to.canWrite) return;
      const files = await Promise.all(items.filter(isFileDropItem).map((item) => item.getFile()));
      if (files.length) {
        upload(files, { place: to.place, shareId: to.shareId }, (name, error) =>
          storageErrorToast(error, `“${name}” was not uploaded`),
        );
      }
    },
    [move, upload],
  );
}

/** Who drags on a surface: through which door, and whether they may change anything. */
export interface DragDoor {
  shareId?: string | undefined;
  canWrite: boolean;
}

/** A surface's drags: its door, and the folder it shows (none for Search's results). */
export interface NodeDrag {
  door: DragDoor;
  here: DropPlace | null;
}

/**
 * A surface's cards or rows as a drag source and a drop target: each item drags; a folder takes
 * a drop into it, and the list's empty room a drop into the folder the page shows.
 */
export function useNodeDragAndDrop(nodes: StorageNode[], drag: NodeDrag | undefined) {
  const into = useDropInto();
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const door = drag?.door ?? { canWrite: false };
  const here = drag?.here ?? null;
  const folderAt = (key: Key): DropPlace | null => {
    const node = byId.get(String(key));
    if (node?.kind !== "folder") return null;
    return { ...door, place: { parentId: node.id }, space: node.space };
  };
  const draggedAt = (keys: Set<Key>) =>
    [...keys].flatMap((key) => {
      const node = byId.get(String(key));
      return node ? [draggedOf(node, door.shareId)] : [];
    });
  return useDragAndDrop<StorageNode>({
    isDisabled: !door.canWrite,
    getItems: (keys) => dragItems(draggedAt(keys)),
    getAllowedDropOperations: () => ["move"],
    onDragStart: (event) => startDrag(draggedAt(event.keys)),
    onDragEnd: endDrag,
    renderDragPreview: (items) => <DragPreview items={items} />,
    shouldAcceptItemDrop: (target) => !!folderAt(target.key),
    getDropOperation: (target) => {
      const to = target.type === "root" ? here : folderAt(target.key);
      return to ? dropOperation(to) : "cancel";
    },
    onItemDrop: (event) => {
      const folder = folderAt(event.target.key);
      if (folder) void into(folder, event.items);
    },
    onRootDrop: (event) => {
      if (here) void into(here, event.items);
    },
  });
}

/** What follows the pointer: the first item's tile and name, and how many more come with it. */
export function DragPreview(props: { items: DragItem[] }) {
  const parsed = draggedSchema.safeParse(JSON.parse(props.items[0]?.[NODE_TYPE] ?? "null"));
  if (!parsed.success) return <span />;
  const node = parsed.data;
  const kind = node.kind === "folder" ? "folder" : fileType(node.name, node.mimeType).kind;
  const more = props.items.length - 1;
  return (
    <span className="flex h-10 max-w-64 items-center gap-2 rounded-lg border bg-surface ps-1 pe-3 text-sm text-foreground shadow-overlay">
      <FileTile kind={kind} />
      <span className="truncate">{node.name}</span>
      {more > 0 && <span className="text-muted-foreground tabular-nums">+{more}</span>}
    </span>
  );
}
