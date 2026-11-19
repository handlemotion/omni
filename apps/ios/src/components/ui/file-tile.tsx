import { StyleSheet, View } from "react-native";
import { BRAND_MARKS, isBranded } from "@/components/brand/file-marks/index.ts";
import { IconFile, IconFileText, IconFileZip, IconImage } from "@/components/icons.ts";
import { extensionOf, fileKindOf, previewKindOf } from "@/lib/file-kind.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz"]);
const MEDIA = /^(video|audio)\//;

function glyphOf(file: { name: string; mimeType: string | null }) {
  if (ARCHIVE.has(extensionOf(file.name))) return IconFileZip;
  const kind = previewKindOf({ ...file, size: 0 });
  if (kind === "image") return IconImage;
  if ((kind === "native" && !MEDIA.test(file.mimeType ?? "")) || kind === "text")
    return IconFileText;
  return IconFile;
}

function Mark({ name, mimeType }: { name: string; mimeType: string | null }) {
  const kind = fileKindOf({ name, mimeType });
  if (isBranded(kind)) {
    const Brand = BRAND_MARKS[kind];
    return <Brand size={iconSize.field} />;
  }
  const Glyph = glyphOf({ name, mimeType });
  return <Glyph size={iconSize.field} color={colors.mutedForeground} />;
}

/**
 * A file's type as the web's `FileTile` draws it: its muted glyph in a 32pt bordered square on the
 * canvas, or the brand's mark for a PDF or an Office file, as the web's `AttachmentGlyph` does.
 */
export function FileTile({ name, mimeType }: { name: string; mimeType: string | null }) {
  return (
    <View accessible={false} style={styles.tile}>
      <Mark name={name} mimeType={mimeType} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: space(8),
    height: space(8),
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
});
