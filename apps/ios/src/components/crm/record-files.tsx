import { useInfiniteQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { ActionSheetIOS, StyleSheet, View } from "react-native";
import { NodeItem } from "@/components/drive/node-item.tsx";
import { NodeRow } from "@/components/drive/node-row.tsx";
import { NodeSheetHost } from "@/components/drive/node-sheet.tsx";
import { IconPlus } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { driveErrorAlert } from "@/lib/drive-actions.ts";
import { addUploads, pickDocuments, pickMedia } from "@/lib/drive-uploads.ts";
import { folderQuery, type DriveNode } from "@/lib/drive.ts";
import {
  useFileLinks,
  useRecordFolder,
  useUnlinkFile,
  type FileRecordKind,
} from "@/lib/crm-files.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { gutter, space } from "@/theme/tokens.ts";

const SHOWN = 6;

function useUpload(kind: FileRecordKind, id: string, folderId: string | null) {
  const folder = useRecordFolder();
  const workspace = useWorkspace().active?.id;
  return async (pick: () => ReturnType<typeof pickDocuments>) => {
    const files = await pick().catch(() => []);
    if (!workspace || !files.length) return;
    try {
      const parentId = folderId ?? (await folder.mutateAsync({ kind, id })).nodeId;
      addUploads(files, { workspace, place: { parentId } });
    } catch (error) {
      driveErrorAlert("The folder was not made")(error);
    }
  };
}

/**
 * A company's or a deal's files on its page: the newest of its folder in Shared (uploads land
 * there, in the background, large ones too) and the Drive files linked to it where they live
 * (`docs/spec/crm.md`, "Keep the files"). A row opens the file's preview; a long press opens Drive's actions on the
 * folder's own files and Remove on a link. All files opens the folder in Drive.
 */
export function RecordFilesSection(props: {
  kind: FileRecordKind;
  id: string;
  name: string;
  folderId: string | null;
}) {
  const own = useInfiniteQuery({
    ...folderQuery({ parent: props.folderId ?? "" }),
    enabled: !!props.folderId,
  });
  const links = useFileLinks(props.kind, props.id);
  const unlink = useUnlinkFile().mutate;
  const upload = useUpload(props.kind, props.id, props.folderId);
  const ownNodes = props.folderId ? (own.data ?? []) : [];
  const linked = (links.data ?? []).filter((node) => node.parentId !== props.folderId);
  const shown = [...ownNodes, ...linked].slice(0, SHOWN);
  const linkedIds = new Set(linked.map((node) => node.id));
  const add = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Upload file", "Upload photo or video", "Add from Drive", "Cancel"],
        cancelButtonIndex: 3,
      },
      (index) => {
        if (index === 0) void upload(pickDocuments);
        if (index === 1) void upload(() => pickMedia({ original: true }));
        if (index === 2) {
          router.push({
            pathname: "/crm/link",
            params: { kind: props.kind, id: props.id, name: props.name },
          });
        }
      },
    );
  const remove = (node: DriveNode) =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: node.name,
        options: [`Remove from ${props.name}`, "Cancel"],
        cancelButtonIndex: 1,
      },
      (index) => {
        if (index !== 0) return;
        unlink(
          { kind: props.kind, id: props.id, nodeId: node.id },
          { onError: driveErrorAlert("It was not removed") },
        );
      },
    );
  return (
    <NodeSheetHost>
      <View>
        <View style={styles.heading}>
          <View style={styles.grow}>
            <SectionHeading label="Files" />
          </View>
          <Button intent="quiet" size="sm" icon={IconPlus} label="Add" onPress={add} />
        </View>
        {shown.map((node) =>
          linkedIds.has(node.id) ? (
            <NodeRow key={node.id} node={node} onLongPress={() => remove(node)} />
          ) : (
            <NodeItem key={node.id} node={node} />
          ),
        )}
        {props.folderId && ownNodes.length + linked.length > SHOWN ? (
          <View style={styles.all}>
            <Button
              intent="plain"
              size="sm"
              label="All files"
              onPress={() =>
                router.push({
                  pathname: "/drive/folder/[id]",
                  params: { id: props.folderId ?? "", name: props.name },
                })
              }
            />
          </View>
        ) : null}
      </View>
    </NodeSheetHost>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: "row", alignItems: "center", paddingEnd: gutter },
  grow: { flex: 1 },
  all: { paddingHorizontal: gutter, paddingTop: space(2), alignItems: "flex-start" },
});
