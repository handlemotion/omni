import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { IconFolder } from "@/components/icons.ts";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { refreshPins } from "@/lib/drive-files.ts";
import { sourceOf } from "@/lib/drive-preview.ts";
import { useFolder, type DriveNode } from "@/lib/drive.ts";
import { gutter, radius, space } from "@/theme/tokens.ts";
import { NodeItem } from "./node-item.tsx";

export const DRIVE_COLUMNS = 3;

type Row = { key: string; nodes: DriveNode[] };

const newestFirst = (a: DriveNode, b: DriveNode) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

function toRows(nodes: DriveNode[], recent: boolean) {
  const folders = nodes.filter((node) => node.kind === "folder");
  const files = nodes.filter((node) => node.kind !== "folder");
  if (recent) files.sort(newestFirst);
  const all = [...folders, ...files];
  const rows: Row[] = [];
  for (let at = 0; at < all.length; at += DRIVE_COLUMNS) {
    const pair = all.slice(at, at + DRIVE_COLUMNS);
    rows.push({ key: `cards:${pair[0]?.id}`, nodes: pair });
  }
  return rows;
}

const folderRows = (nodes: DriveNode[]) => toRows(nodes, false);
const recentRows = (nodes: DriveNode[]) => toRows(nodes, true);

/**
 * A space's top or a folder's contents in one continuous 2-column card grid, matching the web's
 * `FileSections`: folders first, then files, with no section headings. Pinned offline files with a
 * newer version refresh in the background (`refreshPins`).
 */
export function DriveList(props: {
  place: Parameters<typeof useFolder>[0];
  empty: string;
  footerSpace?: number;
  recent?: boolean;
}) {
  const query = useFolder(props.place);
  useEffect(() => {
    const files = query.data?.filter((node) => node.kind === "file");
    if (files?.length) refreshPins(files.map(sourceOf));
  }, [query.data]);
  return (
    <InfiniteList
      query={query}
      rows={props.recent ? recentRows : folderRows}
      keyOf={(row) => row.key}
      renderItem={(row) => <DriveCardsRow nodes={row.nodes} />}
      icon={IconFolder}
      empty={props.empty}
      skeleton={<DriveSkeleton />}
      footerSpace={props.footerSpace ?? 0}
    />
  );
}

export function DriveCardsRow({ nodes }: { nodes: DriveNode[] }) {
  return (
    <View style={styles.grid}>
      {Array.from({ length: DRIVE_COLUMNS }, (_, i) => {
        const node = nodes[i];
        return (
          <View key={node?.id ?? `gap:${i}`} style={styles.cell}>
            {node ? <NodeItem node={node} card /> : null}
          </View>
        );
      })}
    </View>
  );
}

export function DriveSkeleton() {
  return (
    <View style={styles.skeleton}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={styles.grid}>
          {[0, 1, 2].map((col) => (
            <View key={col} style={styles.skeletonCard}>
              <Skeleton width="100%" aspectRatio={1} corner={radius.xl} />
              <Skeleton width="76%" height={14} />
              <Skeleton width="48%" height={11} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    gap: space(3.5),
    paddingHorizontal: gutter,
    paddingBottom: space(4.5),
  },
  cell: { flex: 1, minWidth: 0 },
  skeleton: { paddingTop: space(3) },
  skeletonCard: { flex: 1, minWidth: 0, gap: space(1.5) },
});
