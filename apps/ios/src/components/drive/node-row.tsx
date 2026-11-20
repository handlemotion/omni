import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { fileDay, fileSize, type DriveNode } from "@/lib/drive.ts";
import { colors, space } from "@/theme/tokens.ts";
import { FileTile } from "./file-glyph.tsx";

/**
 * A file or folder as a row, after the desktop's list: its tile, its name, and when it changed
 * and how big it is ("Today · 212 KB"). A folder opens inside Drive's stack, a file in the preview.
 */
export function NodeRow({
  node,
  detail,
  onPress,
  onLongPress,
}: {
  node: DriveNode;
  detail?: string;
  /** Where a tap goes, when not Drive's own folder or file page (a link's, `LinkPage`). */
  onPress?: () => void;
  /** A long press: the node's actions (`NodeSheet`). */
  onLongPress?: () => void;
}) {
  const folder = node.kind === "folder";
  const meta = [detail, fileDay(node.updatedAt), folder ? null : fileSize(node.size)]
    .filter(Boolean)
    .join(" · ");
  return (
    <PressableRow
      style={styles.row}
      onLongPress={onLongPress}
      onPress={
        node.trashedAt
          ? undefined
          : (onPress ??
            (() =>
              router.push(
                folder
                  ? { pathname: "/drive/folder/[id]", params: { id: node.id, name: node.name } }
                  : { pathname: "/drive/file/[id]", params: { id: node.id, name: node.name } },
              )))
      }
    >
      <FileTile node={node} />
      <View style={styles.text}>
        <Text size="body" numberOfLines={1} ellipsizeMode={folder ? "tail" : "middle"}>
          {node.name}
        </Text>
        <Text size="caption" tone="mutedForeground" tabular numberOfLines={1}>
          {meta}
        </Text>
      </View>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: "center", gap: space(3), paddingVertical: 0 },
  text: {
    flex: 1,
    minWidth: 0,
    gap: space(0.5),
    paddingVertical: space(4),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
