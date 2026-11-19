import { ScrollView, StyleSheet } from "react-native";
import { IconFolder } from "@/components/icons.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { useScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { useDriveSearch } from "@/lib/drive.ts";
import { space } from "@/theme/tokens.ts";
import { NodeItem } from "./node-item.tsx";

/** Files and folders whose names hold `q`, folders first; a tap opens one. */
export function DriveSearch({ q, footerSpace }: { q: string; footerSpace: number }) {
  const search = useDriveSearch(q);
  const onScroll = useScrollEdge();
  if (search.isPending) return <ListSkeleton />;
  const nodes = search.data ?? [];
  return (
    <ScrollView
      onScroll={onScroll}
      scrollEventThrottle={16}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.list, { paddingBottom: space(8) + footerSpace }]}
    >
      {nodes.length ? (
        nodes.map((node) => <NodeItem key={node.id} node={node} />)
      ) : (
        <EmptyState
          icon={IconFolder}
          title={search.isError ? "Search didn't load" : "No results"}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ list: { flexGrow: 1, paddingTop: space(1) } });
