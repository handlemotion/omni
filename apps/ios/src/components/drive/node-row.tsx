import { router } from "expo-router";
import { IconFile, IconFolder } from "@/components/icons.ts";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { fileSize, type DriveNode } from "@/lib/drive.ts";
import { listTime } from "@/lib/mail.ts";

/** A file or folder: a folder opens inside Drive's stack, a file in the preview. */
export function NodeRow({ node, detail }: { node: DriveNode; detail?: string }) {
  const folder = node.kind === "folder";
  return (
    <ItemRow
      icon={folder ? IconFolder : IconFile}
      title={node.name}
      ellipsize={folder ? "tail" : "middle"}
      detail={detail ?? (folder ? null : fileSize(node.size))}
      trailing={listTime(node.updatedAt)}
      onPress={
        node.trashedAt
          ? undefined
          : () =>
              router.push(
                folder
                  ? { pathname: "/drive/folder/[id]", params: { id: node.id, name: node.name } }
                  : { pathname: "/drive/file/[id]", params: { id: node.id, name: node.name } },
              )
      }
    />
  );
}
