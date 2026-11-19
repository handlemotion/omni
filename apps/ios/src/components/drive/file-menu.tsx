import { Stack } from "expo-router";
import { promptRename, shareFile, useChangeNode } from "@/lib/drive-actions.ts";
import { openDriveSheet } from "@/lib/drive-sheets.ts";
import { fileSize, type DriveNode } from "@/lib/drive.ts";

const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * The file preview's header menu: Download (the share sheet), Share, Rename, Versions, and the
 * file's size and last change. The `Stack.Toolbar.Menu` element itself, to put inside a
 * `Stack.Toolbar` as is (it drops any other component), so this is a hook.
 */
export function useFileMenu(node: DriveNode | undefined) {
  const rename = useChangeNode().mutate;
  if (!node) return null;
  return (
    <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={`Actions for ${node.name}`}>
      <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={() => void shareFile(node)}>
        Download
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction
        icon="person.badge.plus"
        onPress={() => openDriveSheet("share", node)}
      >
        Share
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptRename(node, rename)}>
        Rename
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction
        icon="clock.arrow.circlepath"
        onPress={() => openDriveSheet("versions", node)}
      >
        Versions
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.Menu inline title="Details">
        <Stack.Toolbar.MenuAction icon="doc" disabled subtitle={fileSize(node.size)}>
          Size
        </Stack.Toolbar.MenuAction>
        <Stack.Toolbar.MenuAction
          icon="clock"
          disabled
          subtitle={DAY.format(new Date(node.updatedAt))}
        >
          Modified
        </Stack.Toolbar.MenuAction>
      </Stack.Toolbar.Menu>
    </Stack.Toolbar.Menu>
  );
}
