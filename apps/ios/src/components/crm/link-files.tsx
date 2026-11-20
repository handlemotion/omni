import { useInfiniteQuery } from "@tanstack/react-query";
import { FlashList } from "@shopify/flash-list";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { FileTile } from "@/components/drive/file-glyph.tsx";
import { IconCheck, IconFolder } from "@/components/icons.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { useLinkFiles, type FileRecordKind } from "@/lib/crm-files.ts";
import { driveErrorAlert } from "@/lib/drive-actions.ts";
import { folderQuery, useDriveSearch, type DriveNode } from "@/lib/drive.ts";
import { useDebounced } from "@/lib/use-debounced.ts";
import { colors, gutter, iconSize, space } from "@/theme/tokens.ts";

type Trail = { id: string; name: string }[];

/**
 * Drive's Shared, a folder at a time, or a search over the member's Drive: a file's row picks it,
 * a folder's row opens it. Add links the picked files to the record where they are.
 */
export function LinkFilesScreen(props: { kind: FileRecordKind; id: string; name: string }) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 200);
  const [trail, setTrail] = useState<Trail>([]);
  const at = trail.at(-1);
  const browse = useInfiniteQuery({
    ...folderQuery(at ? { parent: at.id } : { space: "shared" }),
    enabled: !q,
  });
  const search = useDriveSearch(q);
  const [picked, setPicked] = useState(new Set<string>());
  const link = useLinkFiles();
  const list = q ? search : browse;
  const nodes = (list.data ?? []).filter((node) => !node.trashedAt);
  const tap = (node: DriveNode) => {
    if (node.kind === "folder" && !q) {
      setTrail([...trail, { id: node.id, name: node.name }]);
      return;
    }
    const next = new Set(picked);
    if (next.has(node.id)) next.delete(node.id);
    else next.add(node.id);
    setPicked(next);
  };
  const add = () =>
    link.mutate(
      { kind: props.kind, id: props.id, nodeIds: [...picked] },
      { onSuccess: () => router.back(), onError: driveErrorAlert("The files were not added") },
    );
  return (
    <>
      <Stack.Screen options={{ title: at?.name ?? `Add to ${props.name}` }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button disabled={!picked.size || link.isPending} onPress={add}>
          {picked.size > 1 ? `Add ${picked.size}` : "Add"}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View style={styles.search}>
        <TextField
          label="Search Drive"
          placeholder="Search Drive"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {trail.length && !q ? (
          <Text
            tone="primary"
            accessibilityRole="button"
            onPress={() => setTrail(trail.slice(0, -1))}
          >
            {trail.length > 1 ? (trail.at(-2)?.name ?? "") : "Shared"}
          </Text>
        ) : null}
      </View>
      {list.isPending && list.fetchStatus !== "idle" ? (
        <ListSkeleton />
      ) : nodes.length ? (
        <FlashList
          data={nodes}
          extraData={picked}
          keyExtractor={(node) => node.id}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <PressableRow style={styles.row} onPress={() => tap(item)}>
              <FileTile node={item} />
              <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
                {item.name}
              </Text>
              {picked.has(item.id) ? <IconCheck size={iconSize.md} color={colors.primary} /> : null}
            </PressableRow>
          )}
        />
      ) : (
        <EmptyState icon={IconFolder} title={q ? "No results" : "This folder is empty"} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: gutter, paddingVertical: space(2), gap: space(2) },
  row: { alignItems: "center", paddingVertical: space(2.5) },
  name: { flex: 1, minWidth: 0 },
});
