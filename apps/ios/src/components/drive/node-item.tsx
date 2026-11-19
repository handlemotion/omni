import { Link } from "expo-router";
import { FolderCard } from "@/components/drive/folder-card.tsx";
import { NodeRow } from "@/components/drive/node-row.tsx";
import { NodeSheet } from "@/components/drive/node-sheet.tsx";
import { useSheet } from "@/components/ui/bottom-sheet.tsx";
import { IconArrowRotateClockwise, IconShared, IconTrash } from "@/components/icons.ts";
import { SwipeRow } from "@/components/ui/swipe-row.tsx";
import {
  canTrash,
  confirmDeleteForever,
  driveErrorAlert,
  useDeleteForever,
  useMe,
  useRestoreNode,
  useTrashNode,
} from "@/lib/drive-actions.ts";
import { openDriveSheet } from "@/lib/drive-sheets.ts";
import type { DriveNode } from "@/lib/drive.ts";

/**
 * A file or folder in a space or a folder; a long press opens its actions in a sheet
 * (`NodeSheet`). A folder in the grid draws as its card (`card`). A row swipes right to Share
 * and left to Move to trash.
 */
export function NodeItem({ node, card = false }: { node: DriveNode; card?: boolean }) {
  const me = useMe().data;
  const trash = useTrashNode().mutate;
  const sheet = useSheet();
  const file = node.kind === "file";
  const trashable = canTrash(node, me);
  const item = (
    <>
      {card && !file ? (
        <FolderCard node={node} onLongPress={sheet.open} />
      ) : (
        <NodeRow node={node} onLongPress={sheet.open} />
      )}
      <NodeSheet node={node} sheet={sheet} />
    </>
  );
  if (card && !file) return item;
  return (
    <SwipeRow
      itemKey={node.id}
      right={{
        label: "Share",
        icon: IconShared,
        tone: "primary",
        run: () => openDriveSheet("share", node),
        removes: false,
      }}
      left={
        trashable
          ? {
              label: "Trash",
              icon: IconTrash,
              tone: "danger",
              run: () => trash(node.id, { onError: driveErrorAlert("It was not moved to Trash") }),
            }
          : null
      }
    >
      {item}
    </SwipeRow>
  );
}

/**
 * Something in Trash: Restore, or Delete forever after the web's question, in its menu or by
 * swiping right and left.
 */
export function TrashItem({ node }: { node: DriveNode }) {
  const restore = useRestoreNode().mutate;
  const remove = useDeleteForever().mutate;
  return (
    <SwipeRow
      itemKey={node.id}
      right={{
        label: "Restore",
        icon: IconArrowRotateClockwise,
        tone: "primary",
        run: () => restore(node.id, { onError: driveErrorAlert("It was not restored") }),
      }}
      left={{
        label: "Delete",
        icon: IconTrash,
        tone: "danger",
        run: () => confirmDeleteForever(node, remove),
        removes: false,
      }}
    >
      <Link href={{ pathname: "/drive", params: { page: "trash" } }} asChild>
        <Link.Trigger>
          <NodeRow node={node} />
        </Link.Trigger>
        <Link.Menu>
          <Link.MenuAction
            icon="arrow.uturn.backward"
            title="Restore"
            onPress={() => restore(node.id, { onError: driveErrorAlert("It was not restored") })}
          />
          <Link.MenuAction
            icon="trash"
            title="Delete forever"
            destructive
            onPress={() => confirmDeleteForever(node, remove)}
          />
        </Link.Menu>
      </Link>
    </SwipeRow>
  );
}
