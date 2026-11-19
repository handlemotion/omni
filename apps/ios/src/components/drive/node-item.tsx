import { Link, router, type Href } from "expo-router";
import { NodeRow } from "@/components/drive/node-row.tsx";
import {
  canTrash,
  confirmDeleteForever,
  driveErrorAlert,
  promptRename,
  shareFile,
  useChangeNode,
  useDeleteForever,
  useMe,
  useRestoreNode,
  useTrashNode,
} from "@/lib/drive-actions.ts";
import { openDriveSheet } from "@/lib/drive-sheets.ts";
import type { DriveNode } from "@/lib/drive.ts";

const hrefOf = (node: DriveNode) =>
  (node.kind === "folder"
    ? { pathname: "/drive/folder/[id]", params: { id: node.id, name: node.name } }
    : { pathname: "/drive/file/[id]", params: { id: node.id, name: node.name } }) satisfies Href;

/**
 * A file or folder in a space or a folder, with its actions in a native context menu on a long
 * press: the web's row menu, less what a phone has no room for (comments, signatures, icons).
 */
export function NodeItem({ node }: { node: DriveNode }) {
  const me = useMe().data;
  const rename = useChangeNode().mutate;
  const trash = useTrashNode().mutate;
  const href = hrefOf(node);
  const file = node.kind === "file";
  return (
    <Link href={href} asChild>
      <Link.Trigger>
        <NodeRow node={node} />
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction
          icon={file ? "doc" : "folder"}
          title="Open"
          onPress={() => router.push(href)}
        />
        {file ? (
          <Link.MenuAction
            icon="square.and.arrow.up"
            title="Download"
            onPress={() => void shareFile(node)}
          />
        ) : null}
        <Link.MenuAction
          icon="person.badge.plus"
          title="Share"
          onPress={() => openDriveSheet("share", node)}
        />
        <Link.MenuAction icon="pencil" title="Rename" onPress={() => promptRename(node, rename)} />
        <Link.MenuAction icon="folder" title="Move" onPress={() => openDriveSheet("move", node)} />
        {file ? (
          <Link.MenuAction
            icon="clock.arrow.circlepath"
            title="Versions"
            onPress={() => openDriveSheet("versions", node)}
          />
        ) : null}
        {canTrash(node, me) ? (
          <Link.MenuAction
            icon="trash"
            title="Move to trash"
            destructive
            onPress={() =>
              trash(node.id, { onError: driveErrorAlert("It was not moved to Trash") })
            }
          />
        ) : null}
      </Link.Menu>
    </Link>
  );
}

/** Something in Trash: Restore, or Delete forever after the web's question. */
export function TrashItem({ node }: { node: DriveNode }) {
  const restore = useRestoreNode().mutate;
  const remove = useDeleteForever().mutate;
  return (
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
  );
}
