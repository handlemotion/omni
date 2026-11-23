import { useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { ClipPath, Defs, G, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { IconFolderFilled } from "@/components/icons.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { colors, iconSize, radius } from "@/theme/tokens.ts";
import { FileGlyph, hasThumbnail, kindOf, Thumbnail } from "./file-glyph.tsx";

type Spot = readonly [left: number, top: number, width: number, turn: number];

const ONE: Spot = [21, 6, 58, -3];

const PEEK: readonly (readonly Spot[])[] = [
  [ONE],
  [
    [5, 8, 56, -5],
    [39, 10, 56, 5],
  ],
  [
    [3, 11, 50, -7],
    [25, 5, 50, 0],
    [47, 11, 50, 7],
  ],
];

const BACK =
  "M0 5A5 5 0 0 1 5 0H33C37.5 0 38.5 1.5 40.5 3.5S44 7 48 7H95A5 5 0 0 1 100 12V95A5 5 0 0 1 95 100H5A5 5 0 0 1 0 95Z";

const pct = (value: number) => `${value}%` as const;

const place = ([left, top, width, turn]: Spot) => ({
  left: pct(left),
  top: pct(top),
  width: pct(width),
  transform: [{ rotate: `${turn}deg` }],
});

function pick(nodes: DriveNode[]) {
  const files = nodes.filter((n) => n.kind === "file");
  const folders = nodes.filter((n) => n.kind === "folder");
  return [...files, ...folders].slice(0, PEEK.length);
}

/**
 * The web's `FolderArt` 1:1: a grey pocket with a tabbed back panel, up to three of the folder's
 * items standing inside it as angled 4:3 cards, and a translucent frosted front flap over their
 * lower 65%. Empty folders draw the bare pocket.
 */
export function FolderArt({ contents }: { contents: DriveNode[] | undefined }) {
  const cards = contents ? pick(contents) : [];
  const spots = PEEK[cards.length - 1] ?? [];
  return (
    <View style={styles.pocket}>
      <Back />
      {cards.map((card, i) => (
        <Card key={card.id} node={card} spot={spots[i] ?? ONE} />
      ))}
      <Front />
    </View>
  );
}

function Back() {
  const id = useId();
  return (
    <Svg viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={`${id}fill`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.folderBackTop} />
          <Stop offset="1" stopColor={colors.folderBackBottom} />
        </LinearGradient>
        <ClipPath id={`${id}clip`}>
          <Path d={BACK} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#${id}clip)`}>
        <Path d={BACK} fill={`url(#${id}fill)`} />
        <Path d={BACK} fill="none" stroke={colors.folderEdge} strokeWidth={2} />
      </G>
    </Svg>
  );
}

function Front() {
  const id = useId();
  return (
    <View style={styles.front} pointerEvents="none">
      <Svg viewBox="0 0 100 100" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={`${id}front`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.folderFrontTop} />
            <Stop offset="1" stopColor={colors.folderFrontBottom} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="100" fill={`url(#${id}front)`} />
      </Svg>
      <View style={styles.shine} />
    </View>
  );
}

function Card({ node, spot }: { node: DriveNode; spot: Spot }) {
  return (
    <View style={[styles.card, place(spot)]}>
      {node.kind === "folder" ? (
        <IconFolderFilled size={iconSize.lg} color={colors.primary} />
      ) : (
        <FileGlyph kind={kindOf(node)} size={iconSize.lg} />
      )}
      {hasThumbnail(node) ? <Thumbnail node={node} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pocket: {
    aspectRatio: 1,
    borderRadius: radius.xl,
    overflow: "hidden",
    position: "relative",
  },
  card: {
    position: "absolute",
    aspectRatio: 4 / 3,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  front: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "35%",
    bottom: 0,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.folderEdge,
    overflow: "hidden",
  },
  shine: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.folderShine,
  },
});
