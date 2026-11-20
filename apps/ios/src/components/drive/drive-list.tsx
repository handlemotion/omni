import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { IconFolder } from "@/components/icons.ts";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { refreshPins } from "@/lib/drive-files.ts";
import { sourceOf } from "@/lib/drive-preview.ts";
import { useFolder, type DriveNode } from "@/lib/drive.ts";
import { colors, gutter, radius, space } from "@/theme/tokens.ts";
import { NodeItem } from "./node-item.tsx";

const COLUMNS = 3;

type Row =
  | { type: "heading"; key: string; label: string; rule: boolean }
  | { type: "folders"; key: string; nodes: DriveNode[] }
  | { type: "file"; key: string; node: DriveNode };

const newestFirst = (a: DriveNode, b: DriveNode) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

function toRows(nodes: DriveNode[], recent: boolean) {
  const folders = nodes.filter((node) => node.kind === "folder");
  const files = nodes.filter((node) => node.kind !== "folder");
  if (recent) files.sort(newestFirst);
  const rows: Row[] = [];
  if (folders.length) rows.push({ type: "heading", key: "folders", label: "Folders", rule: false });
  for (let at = 0; at < folders.length; at += COLUMNS) {
    const three = folders.slice(at, at + COLUMNS);
    rows.push({ type: "folders", key: `folders:${three[0]?.id}`, nodes: three });
  }
  if (files.length) {
    rows.push({ type: "heading", key: "files", label: recent ? "Recent" : "Files", rule: true });
  }
  for (const node of files) rows.push({ type: "file", key: node.id, node });
  return rows;
}

const folderRows = (nodes: DriveNode[]) => toRows(nodes, false);
const recentRows = (nodes: DriveNode[]) => toRows(nodes, true);

/**
 * A space's top or a folder's contents, as Drive's board lays them out: its folders in a grid of
 * three cards under "Folders", then its files as rows under "Files", in the API's name order. A
 * space's top (`recent`) heads them "Recent" instead and puts the latest updated first, among the
 * pages loaded so far. A file made available offline that has a new version here is downloaded
 * again (`refreshPins`).
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
      typeOf={(row) => row.type}
      renderItem={(row) => <DriveRow row={row} />}
      icon={IconFolder}
      empty={props.empty}
      skeleton={<DriveSkeleton />}
      footerSpace={props.footerSpace ?? 0}
    />
  );
}

function DriveRow({ row }: { row: Row }) {
  if (row.type === "file") return <NodeItem node={row.node} />;
  if (row.type === "heading") return <DriveHeading label={row.label} rule={row.rule} />;
  return (
    <View style={styles.grid}>
      {Array.from({ length: COLUMNS }, (_, i) => {
        const node = row.nodes[i];
        return (
          <View key={node?.id ?? `gap:${i}`} style={styles.cell}>
            {node ? <NodeItem node={node} card /> : null}
          </View>
        );
      })}
    </View>
  );
}

function DriveHeading({ label, rule }: { label: string; rule: boolean }) {
  return (
    <View accessibilityRole="header" accessible style={[styles.heading, rule && styles.rule]}>
      <Text size="subhead" weight="medium" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function DriveSkeleton() {
  return (
    <View>
      <View style={[styles.heading, styles.rule]}>
        <Skeleton width="20%" height={15} />
      </View>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <View key={row} style={styles.skeletonRow}>
          <Skeleton width={space(10)} height={space(10)} corner={radius.xl} />
          <View style={styles.skeletonText}>
            <Skeleton width="55%" height={16} />
            <Skeleton width="30%" height={13} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { height: space(11), justifyContent: "center", paddingHorizontal: gutter },
  rule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  grid: {
    flexDirection: "row",
    gap: space(3),
    paddingHorizontal: gutter,
    paddingBottom: space(3),
  },
  cell: { flex: 1, minWidth: 0 },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: gutter,
  },
  skeletonText: {
    flex: 1,
    gap: space(2),
    paddingVertical: space(4),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
