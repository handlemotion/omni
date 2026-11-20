import { FlashList } from "@shopify/flash-list";
import { StyleSheet, View } from "react-native";
import { IconFolder } from "@/components/icons.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { useScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { useDriveSearch } from "@/lib/drive.ts";
import { space } from "@/theme/tokens.ts";
import { NodeItem } from "./node-item.tsx";

/**
 * Files and folders whose names hold `q`, folders first; a tap opens one. Rows recycle
 * (FlashList), so a search that matches thousands scrolls as a folder does.
 */
export function DriveSearch({ q, footerSpace }: { q: string; footerSpace: number }) {
  const search = useDriveSearch(q);
  const onScroll = useScrollEdge();
  if (search.isPending) return <ListSkeleton />;
  const nodes = search.data ?? [];
  if (!nodes.length) {
    return (
      <View style={styles.fill}>
        <EmptyState
          icon={IconFolder}
          title={search.isError ? "Search didn't load" : "No results"}
        />
      </View>
    );
  }
  return (
    <FlashList
      data={nodes}
      keyExtractor={(node) => node.id}
      renderItem={({ item }) => <NodeItem node={item} />}
      onScroll={onScroll}
      scrollEventThrottle={16}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: space(1), paddingBottom: space(8) + footerSpace }}
    />
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
