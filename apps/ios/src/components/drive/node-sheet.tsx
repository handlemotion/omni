import { createContext, use, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import {
  IconDownload,
  IconFolder,
  IconHistory,
  IconOffline,
  IconRename,
  IconTrash,
  IconUserAdd,
} from "@/components/icons.ts";
import { MenuRow, SheetDivider } from "@/components/shell/menu-row.tsx";
import { BottomSheet, useSheet } from "@/components/ui/bottom-sheet.tsx";
import { Text } from "@/components/ui/text.tsx";
import {
  canTrash,
  driveErrorAlert,
  promptRename,
  shareFile,
  useChangeNode,
  useMe,
  useTrashNode,
} from "@/lib/drive-actions.ts";
import { pinFile, unpinFile, usePinned } from "@/lib/drive-files.ts";
import { sourceOf } from "@/lib/drive-preview.ts";
import { openDriveSheet } from "@/lib/drive-sheets.ts";
import { fileDay, fileSize, type DriveNode } from "@/lib/drive.ts";
import { space } from "@/theme/tokens.ts";
import { FileTile } from "./file-glyph.tsx";

/**
 * A file's or folder's actions in a sheet, under its tile, name, day and size: Share and Save to
 * Files, and (a file's) Make available offline or Remove download; Rename, Move and (a file's)
 * Versions; Move to Trash. `pick` closes the sheet and runs
 * the action once it has gone (`useSheet().pick`), so a prompt or a sheet it opens is not under it.
 */
export function NodeSheet(props: {
  node: DriveNode;
  sheet: ReturnType<typeof useSheet>;
  /** Once it is in Trash (a preview goes back to its folder). */
  onTrashed?: () => void;
}) {
  const { node, sheet } = props;
  const pick = sheet.pick;
  const me = useMe().data;
  const rename = useChangeNode().mutate;
  const trash = useTrashNode().mutate;
  const pinned = usePinned(node.id);
  const file = node.kind === "file";
  const meta = [fileDay(node.updatedAt), file ? fileSize(node.size) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <BottomSheet
      isOpen={sheet.isOpen}
      onClose={sheet.close}
      onClosed={sheet.onClosed}
      title={node.name}
      header={
        <View style={styles.header}>
          <FileTile node={node} />
          <View style={styles.text}>
            <Text
              weight="semibold"
              numberOfLines={1}
              ellipsizeMode="middle"
              accessibilityRole="header"
            >
              {node.name}
            </Text>
            <Text size="sm" tone="mutedForeground" tabular numberOfLines={1}>
              {meta}
            </Text>
          </View>
        </View>
      }
    >
      <SheetDivider />
      <MenuRow
        icon={IconUserAdd}
        muted
        label="Share"
        onPress={() => pick(() => openDriveSheet("share", node))}
      />
      {file ? (
        <MenuRow
          icon={IconDownload}
          muted
          label="Save to Files"
          onPress={() => pick(() => void shareFile(node))}
        />
      ) : null}
      {file ? (
        <MenuRow
          icon={IconOffline}
          muted
          label={pinned ? "Remove download" : "Make available offline"}
          onPress={() =>
            pick(() =>
              pinned
                ? unpinFile(node.id)
                : void pinFile(sourceOf(node)).catch(driveErrorAlert("It was not downloaded")),
            )
          }
        />
      ) : null}
      <SheetDivider />
      <MenuRow
        icon={IconRename}
        muted
        label="Rename"
        onPress={() => pick(() => promptRename(node, rename))}
      />
      <MenuRow
        icon={IconFolder}
        muted
        label="Move"
        onPress={() => pick(() => openDriveSheet("move", node))}
      />
      {file ? (
        <MenuRow
          icon={IconHistory}
          muted
          label="Versions"
          onPress={() => pick(() => openDriveSheet("versions", node))}
        />
      ) : null}
      {canTrash(node, me) ? (
        <>
          <SheetDivider />
          <MenuRow
            icon={IconTrash}
            destructive
            label="Move to Trash"
            onPress={() =>
              pick(() =>
                trash(node.id, {
                  onSuccess: props.onTrashed,
                  onError: driveErrorAlert("It was not moved to Trash"),
                }),
              )
            }
          />
        </>
      ) : null}
    </BottomSheet>
  );
}

const OpenNodeSheet = createContext<((node: DriveNode) => void) | null>(null);

/**
 * One `NodeSheet` for every row under it, opened on the row a long press picked, instead of a
 * sheet (and its modal) mounted per row. Drive's stack holds one.
 */
export function NodeSheetHost({ children }: { children: ReactNode }) {
  const sheet = useSheet();
  const [node, setNode] = useState<DriveNode | null>(null);
  const open = (one: DriveNode) => {
    setNode(one);
    sheet.open();
  };
  return (
    <OpenNodeSheet value={open}>
      {children}
      {node ? <NodeSheet node={node} sheet={sheet} /> : null}
    </OpenNodeSheet>
  );
}

/** Opens the nearest `NodeSheetHost`'s sheet on a node; null outside one. */
export const useOpenNodeSheet = () => use(OpenNodeSheet);

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3.5),
    paddingHorizontal: space(3.5),
    paddingTop: space(1.5),
    paddingBottom: space(2),
  },
  text: { flex: 1, minWidth: 0, gap: space(0.5) },
});
