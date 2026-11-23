import { Image } from "expo-image";
import { useState, type ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { BRAND_MARKS, isBranded, type BrandedKind } from "@/components/brand/file-marks/index.ts";
import {
  IconAudio,
  IconCode,
  IconFile,
  IconFileText,
  IconFileZip,
  IconFolder,
  IconImage,
  IconTable,
  IconVideo,
} from "@/components/icons.ts";
import { thumbnailUrl, useStorageHeaders, versionOf } from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { fileKindOf, previewKindOf, type FileKind } from "@/lib/file-kind.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;

const GLYPH: Record<Exclude<FileKind, BrandedKind> | "folder", Glyph> = {
  folder: IconFolder,
  doc: IconFileText,
  image: IconImage,
  video: IconVideo,
  audio: IconAudio,
  code: IconCode,
  text: IconFileText,
  csv: IconTable,
  archive: IconFileZip,
  other: IconFile,
};

/** Images over this draw their glyph: the Worker draws thumbnails from originals up to 20 MB. */
export const THUMBNAIL_MAX_BYTES = 20_000_000;

/**
 * A file's or folder's glyph, muted as every icon is at rest; a PDF or an Office file shows its
 * brand's mark in its own colours, as on the web.
 */
export function FileGlyph(props: { kind: FileKind | "folder"; size: number }) {
  if (isBranded(props.kind)) {
    const Mark = BRAND_MARKS[props.kind];
    return <Mark size={props.size} />;
  }
  const Glyph = GLYPH[props.kind];
  return <Glyph size={props.size} color={colors.mutedForeground} />;
}

/** Which glyph `node` draws. */
export const kindOf = (node: DriveNode) => (node.kind === "folder" ? "folder" : fileKindOf(node));

/** Whether `node` is an image small enough to draw from its bytes. */
export const hasThumbnail = (node: DriveNode) =>
  node.kind === "file" && previewKindOf(node) === "image" && node.size <= THUMBNAIL_MAX_BYTES;

/**
 * An image's own picture, filling the box it sits in, over the glyph until it loads: the Worker's
 * 256 px thumbnail, never the original. One it can't draw (`415`) leaves the glyph.
 */
export function Thumbnail({ node }: { node: DriveNode }) {
  const headers = useStorageHeaders().data;
  const cacheKey = `${node.id}:${versionOf(node)}:256`;
  const [failed, setFailed] = useState<string | null>(null);
  if (!headers || failed === cacheKey) return null;
  return (
    <Image
      source={{
        uri: thumbnailUrl(node, 256),
        headers,
        cacheKey,
      }}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      transition={200}
      recyclingKey={node.id}
      onError={() => setFailed(cacheKey)}
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
