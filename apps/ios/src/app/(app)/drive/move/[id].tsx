import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { SheetHeader } from "@/components/drive/sheet-header.tsx";
import { IconFolder } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { driveErrorAlert, useChangeNode, useNode } from "@/lib/drive-actions.ts";
import { DRIVE_PAGES, useFolder, type DriveNode } from "@/lib/drive.ts";
import { keys } from "@/lib/query-keys.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { colors, space } from "@/theme/tokens.ts";

type Space = Exclude<DriveNode["space"], "teamspace">;
type Step = { id: string; name: string };
type At = { space: Space; path: Step[] } | null;

const SPACE_LABEL: Record<Space, string> = {
  personal: DRIVE_PAGES.my.label,
  shared: DRIVE_PAGES.shared.label,
};

/** Picks the folder to move a file or folder into, one level at a time, then Move here. */
export default function MoveSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const node = useNode(id);
  if (node.data) return <MovePicker node={node.data.node} />;
  if (node.isError) {
    return (
      <EmptyState icon={IconFolder} title="This list didn't load">
        <Button intent="plain" label="Try again" onPress={() => void node.refetch()} />
      </EmptyState>
    );
  }
  return <ListSkeleton />;
}

type FolderPages = InfiniteData<{ folder: { path: Step[] } | null }>;

function MovePicker({ node }: { node: DriveNode }) {
  const client = useQueryClient();
  const company = hasCrm(useWorkspace().active);
  const move = useChangeNode();
  const [at, setAt] = useState<At>(() => {
    const parent = node.parentId
      ? client.getQueryData<FolderPages>(keys.drive("folder", node.parentId))?.pages[0]?.folder
      : null;
    const space = node.space === "shared" ? "shared" : "personal";
    return { space, path: parent?.path.map(({ id, name }) => ({ id, name })) ?? [] };
  });
  const folder = at?.path.at(-1);
  const place = at ? (folder ? { parentId: folder.id } : { space: at.space }) : null;
  const here =
    !!at && (folder?.id ?? null) === node.parentId && (folder ? true : at.space === node.space);
  const crumbs: (Step & { go: () => void })[] = [
    ...(company ? [{ id: "top", name: "Drive", go: () => setAt(null) }] : []),
    ...(at
      ? [
          {
            id: at.space,
            name: SPACE_LABEL[at.space],
            go: () => setAt({ space: at.space, path: [] }),
          },
          ...at.path.map((step, i) => ({
            ...step,
            go: () => setAt({ space: at.space, path: at.path.slice(0, i + 1) }),
          })),
        ]
      : []),
  ];
  return (
    <View style={styles.sheet}>
      <SheetHeader title={`Move “${node.name}”`}>
        <Button
          label="Move here"
          disabled={!place || here}
          isPending={move.isPending}
          onPress={() =>
            place &&
            move.mutate(
              { id: node.id, place },
              { onSuccess: () => router.back(), onError: driveErrorAlert("It was not moved") },
            )
          }
        />
      </SheetHeader>
      <View style={styles.crumbs}>
        {crumbs.map((crumb, i) => (
          <View key={crumb.id} style={styles.crumb}>
            {i > 0 ? <Text tone="subtleForeground">/</Text> : null}
            <Button intent="quiet" style={styles.center} label={crumb.name} onPress={crumb.go} />
          </View>
        ))}
      </View>
      {at ? (
        <Folders
          place={folder ? { parent: folder.id } : { space: at.space }}
          skip={node.id}
          onEnter={(step) => setAt({ space: at.space, path: [...at.path, step] })}
        />
      ) : (
        <FlatList
          data={(["personal", "shared"] as const).map((id) => ({ id, name: SPACE_LABEL[id] }))}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => (
            <ItemRow
              icon={IconFolder}
              title={item.name}
              onPress={() => setAt({ space: item.id, path: [] })}
            />
          )}
        />
      )}
    </View>
  );
}

function Folders(props: {
  place: { space: Space } | { parent: string };
  skip: string;
  onEnter: (step: Step) => void;
}) {
  const query = useFolder(props.place);
  if (query.isPending) return <ListSkeleton />;
  const folders = (query.data ?? []).filter((n) => n.kind === "folder" && n.id !== props.skip);
  return (
    <FlatList
      data={folders}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => (
        <ItemRow
          icon={IconFolder}
          title={item.name}
          onPress={() => props.onEnter({ id: item.id, name: item.name })}
        />
      )}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignSelf: "center" },
  sheet: { flex: 1, backgroundColor: colors.background },
  crumbs: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space(1),
    paddingHorizontal: space(2),
    paddingBottom: space(2),
  },
  crumb: { flexDirection: "row", alignItems: "center", gap: space(1) },
});
