import { StyleSheet, View } from "react-native";
import { IconFolderFilled, IconFolderOpenFilled } from "@/components/icons.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import { FileGlyph, hasThumbnail, kindOf, Thumbnail } from "./file-glyph.tsx";

type Spot = readonly [left: number, top: number, width: number, height: number];

const EMPTY: Spot = [27, 22, 46, 50];
const STACK: readonly (readonly Spot[])[] = [
  [EMPTY],
  [
    [38, 36, 40, 40],
    [22, 20, 40, 40],
  ],
  [
    [30, 40, 40, 38],
    [14, 18, 40, 38],
    [46, 24, 40, 38],
  ],
];

const pct = (value: number) => `${value}%` as const;

const place = ([left, top, width, height]: Spot) => ({
  left: pct(left),
  top: pct(top),
  width: pct(width),
  height: pct(height),
});

function pick(nodes: DriveNode[]) {
  const files = nodes.filter((n) => n.kind === "file");
  const folders = nodes.filter((n) => n.kind === "folder");
  return [...files, ...folders].slice(0, STACK.length);
}

/**
 * The desktop's `FolderArt`: a square bordered tile with up to three of the folder's files fanned
 * on it as small cards, at the desktop's spots, the first on top; the open folder when it is
 * empty. `contents` is undefined while they load.
 */
export function FolderArt({ contents }: { contents: DriveNode[] | undefined }) {
  const cards = contents ? pick(contents) : [];
  const spots = STACK[cards.length - 1] ?? [];
  return (
    <View style={styles.tile}>
      {contents?.length === 0 ? (
        <IconFolderOpenFilled size={space(7)} color={colors.subtleForeground} />
      ) : null}
      {cards
        .map((card, i) => <Card key={card.id} node={card} spot={spots[i] ?? EMPTY} />)
        .toReversed()}
    </View>
  );
}

function Card({ node, spot }: { node: DriveNode; spot: Spot }) {
  return (
    <View style={[styles.card, place(spot)]}>
      {node.kind === "folder" ? (
        <IconFolderFilled size={iconSize.field} color={colors.primary} />
      ) : (
        <FileGlyph kind={kindOf(node)} size={iconSize.field} />
      )}
      {hasThumbnail(node) ? <Thumbnail node={node} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    aspectRatio: 1,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    position: "absolute",
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
});
