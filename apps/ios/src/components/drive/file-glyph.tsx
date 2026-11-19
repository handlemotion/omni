import { Image } from "expo-image";
import type { ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import {
  IconAudio,
  IconCode,
  IconFile,
  IconFilePdf,
  IconFileText,
  IconFileZip,
  IconFolder,
  IconImage,
  IconPresentation,
  IconTable,
  IconVideo,
} from "@/components/icons.ts";
import { contentUrl, useStorageHeaders, versionOf } from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { fileKindOf, previewKindOf, type FileKind } from "@/lib/file-kind.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;

const GLYPH: Record<FileKind | "folder", Glyph> = {
  folder: IconFolder,
  image: IconImage,
  video: IconVideo,
  audio: IconAudio,
  pdf: IconFilePdf,
  code: IconCode,
  text: IconFileText,
  csv: IconTable,
  spreadsheet: IconTable,
  document: IconFileText,
  presentation: IconPresentation,
  archive: IconFileZip,
  other: IconFile,
};

/** Images over this draw their glyph, as the web's grid does: a thumbnail reads the original. */
export const THUMBNAIL_MAX_BYTES = 20 * 1024 * 1024;

/** A file's or folder's glyph, muted as every icon is at rest. */
export function FileGlyph(props: { kind: FileKind | "folder"; size: number }) {
  const Glyph = GLYPH[props.kind];
  return <Glyph size={props.size} color={colors.mutedForeground} />;
}

/** Which glyph `node` draws. */
export const kindOf = (node: DriveNode) => (node.kind === "folder" ? "folder" : fileKindOf(node));

/** Whether `node` is an image small enough to draw from its bytes. */
export const hasThumbnail = (node: DriveNode) =>
  node.kind === "file" && previewKindOf(node) === "image" && node.size <= THUMBNAIL_MAX_BYTES;

/** An image's own picture, filling the box it sits in, over the glyph until it loads. */
export function Thumbnail({ node }: { node: DriveNode }) {
  const headers = useStorageHeaders().data;
  if (!headers) return null;
  return (
    <Image
      source={{ uri: contentUrl(node.id), headers, cacheKey: `${node.id}:${versionOf(node)}` }}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      transition={200}
      recyclingKey={node.id}
    />
  );
}

/**
 * The desktop's `RowTile`: the glyph in its bordered white square, or an image's thumbnail in
 * the same square.
 */
export function FileTile({ node }: { node: DriveNode }) {
  return (
    <View style={styles.tile}>
      <FileGlyph kind={kindOf(node)} size={iconSize.md} />
      {hasThumbnail(node) ? <Thumbnail node={node} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: space(10),
    height: space(10),
    flexShrink: 0,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
