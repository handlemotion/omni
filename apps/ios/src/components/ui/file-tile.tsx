import { StyleSheet, View } from "react-native";
import { IconFile, IconFileText, IconFileZip, IconImage } from "@/components/icons.ts";
import { extensionOf, previewKindOf } from "@/lib/file-kind.ts";
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

/**
 * A file's type as the web's `FileTile` draws it: its muted glyph in a 32pt bordered square on the
 * canvas.
 */
export function FileTile({ name, mimeType }: { name: string; mimeType: string | null }) {
  const Glyph = glyphOf({ name, mimeType });
  return (
    <View accessible={false} style={styles.tile}>
      <Glyph size={iconSize.field} color={colors.mutedForeground} />
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
