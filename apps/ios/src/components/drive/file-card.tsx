import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { fileSize, type DriveNode } from "@/lib/drive.ts";
import { fileKindOf, fileLabelOf, hasCardPage } from "@/lib/file-kind.ts";
import { colors, radius, space } from "@/theme/tokens.ts";
import { AudioArt, FilePage } from "./card-art.tsx";
import { FileGlyph, hasThumbnail, Thumbnail } from "./file-glyph.tsx";

const DEFAULT_CARD_WIDTH = 110;

/**
 * A file in the 3-column grid, matching the web's `FileCard` 1:1: a square bordered preview tile
 * showing the file's content (thumbnail, mini page, waveform, or brand/file glyph), followed by
 * its name and size/type metadata.
 */
export function FileCard({ node, onLongPress }: { node: DriveNode; onLongPress?: () => void }) {
  const [width, setWidth] = useState(DEFAULT_CARD_WIDTH);
  return (
    <PressableRow
      style={styles.card}
      accessibilityLabel={node.name}
      onLongPress={onLongPress}
      onPress={() =>
        router.push({ pathname: "/drive/file/[id]", params: { id: node.id, name: node.name } })
      }
    >
      <View
        style={styles.tile}
        onLayout={(event) => {
          const next = Math.round(event.nativeEvent.layout.width);
          if (next > 0 && next !== width) setWidth(next);
        }}
      >
        <FileArt node={node} width={width} />
      </View>
      <View style={styles.text}>
        <Text size="subhead" numberOfLines={1} ellipsizeMode="middle">
          {node.name}
        </Text>
        <Text size="caption" tone="mutedForeground" tabular numberOfLines={1}>
          {`${fileSize(node.size)} · ${fileLabelOf(node)}`}
        </Text>
      </View>
    </PressableRow>
  );
}

function FileArt({ node, width }: { node: DriveNode; width: number }) {
  const kind = fileKindOf(node);
  if (hasThumbnail(node)) {
    return (
      <>
        <FileGlyph kind="image" size={space(8)} />
        <Thumbnail node={node} />
      </>
    );
  }
  if (node.size > 0 && kind === "audio") return <AudioArt name={node.name} />;
  if (hasCardPage(node)) return <FilePage node={node} width={width} />;
  return <FileGlyph kind={kind} size={space(8)} />;
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 0,
    flexDirection: "column",
    gap: space(2),
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  tile: {
    aspectRatio: 1,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  text: { gap: space(0.5), paddingLeft: space(0.5) },
});
