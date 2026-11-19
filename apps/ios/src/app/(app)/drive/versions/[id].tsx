import { router, useLocalSearchParams } from "expo-router";
import { ActionSheetIOS, ScrollView, StyleSheet, View } from "react-native";
import { SheetHeader } from "@/components/drive/sheet-header.tsx";
import { IconFile } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { driveErrorAlert, placeOf, shareVersion, useNode } from "@/lib/drive-actions.ts";
import { useRestoreVersion, useVersions, type DriveVersions } from "@/lib/drive-sharing.ts";
import { addUploads, pickDocuments } from "@/lib/drive-uploads.ts";
import { fileSize, type DriveNode } from "@/lib/drive.ts";
import { colors, space } from "@/theme/tokens.ts";

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A file's versions: the current content, then each kept one to download or restore. */
export default function VersionsSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const node = useNode(id).data?.node;
  const versions = useVersions(id);
  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content}>
      <SheetHeader title={node ? `Versions of “${node.name}”` : "Versions"}>
        <Button intent="quiet" style={styles.center} label="Done" onPress={() => router.back()} />
      </SheetHeader>
      {versions.data && node ? (
        <List node={node} data={versions.data} />
      ) : versions.isError ? (
        <EmptyState icon={IconFile} title="This list didn't load">
          <Button intent="plain" label="Try again" onPress={() => void versions.refetch()} />
        </EmptyState>
      ) : (
        <ListSkeleton />
      )}
    </ScrollView>
  );
}

function List({ node, data }: { node: DriveNode; data: DriveVersions }) {
  const restore = useRestoreVersion();
  const upload = async () => {
    const [file] = await pickDocuments().catch(() => []);
    if (file)
      addUploads([file], { workspace: node.orgId, place: placeOf(node), replaces: node.id });
  };
  return (
    <View>
      <Row content={data.current} end="Current" />
      {data.versions.map((version) => (
        <Row
          key={version.id}
          content={version}
          onPress={() =>
            ActionSheetIOS.showActionSheetWithOptions(
              {
                title: WHEN.format(new Date(version.writtenAt)),
                options: ["Download", "Restore", "Cancel"],
                cancelButtonIndex: 2,
              },
              (index) => {
                if (index === 0) void shareVersion(node, version.id);
                if (index === 1) {
                  restore.mutate(
                    { id: node.id, versionId: version.id },
                    { onError: driveErrorAlert("It was not restored") },
                  );
                }
              },
            )
          }
        />
      ))}
      <View style={styles.footer}>
        <Button intent="plain" label="Upload new version" onPress={() => void upload()} />
      </View>
    </View>
  );
}

function Row(props: { content: DriveVersions["current"]; end?: string; onPress?: () => void }) {
  const { content } = props;
  return (
    <PressableRow onPress={props.onPress} style={styles.row}>
      <View style={styles.grow}>
        <Text tabular numberOfLines={1}>
          {WHEN.format(new Date(content.writtenAt))}
        </Text>
        {content.writtenByName ? (
          <Text size="sm" tone="mutedForeground" numberOfLines={1}>
            {content.writtenByName}
          </Text>
        ) : null}
      </View>
      <Text size="sm" tone="mutedForeground" tabular>
        {fileSize(content.size)}
      </Text>
      {props.end ? (
        <Text size="sm" tone="primary">
          {props.end}
        </Text>
      ) : null}
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  center: { alignSelf: "center" },
  sheet: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space(8) },
  row: { alignItems: "center" },
  grow: { flex: 1, gap: space(0.5) },
  footer: { paddingHorizontal: space(4), paddingTop: space(4) },
});
