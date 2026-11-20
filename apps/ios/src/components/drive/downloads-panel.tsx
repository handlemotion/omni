import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconX } from "@/components/icons.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cancelDownload, useDownloads, type DownloadItem } from "@/lib/drive-files.ts";
import { useUploads } from "@/lib/drive-uploads.ts";
import { colors, radius, shadowRaised, space } from "@/theme/tokens.ts";

/**
 * Downloads the person asked for (Save to Files, Make available offline) on their way, over the
 * bottom of Drive's screens as the uploads panel is: a name, how far it is, Cancel. It waits
 * while the uploads panel is up, so the two never sit on each other.
 */
export function DownloadsPanel() {
  const downloads = useDownloads().filter((item) => item.shown);
  const uploading = useUploads().length > 0;
  if (!downloads.length || uploading) return null;
  return (
    <SafeAreaView edges={["bottom"]} style={styles.dock} pointerEvents="box-none">
      <ScrollView style={styles.panel} contentContainerStyle={styles.rows}>
        {downloads.map((item) => (
          <Row key={item.key} item={item} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ item }: { item: DownloadItem }) {
  const percent = item.total > 0 ? Math.min(100, Math.floor((item.written / item.total) * 100)) : 0;
  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <Text size="sm" numberOfLines={1} style={styles.name}>
          {item.name}
        </Text>
        <Text size="sm" tone="mutedForeground" tabular>
          {percent}%
        </Text>
        <IconButton
          icon={IconX}
          label={`Cancel ${item.name}`}
          onPress={() => cancelDownload(item.key)}
        />
      </View>
      <View
        style={styles.track}
        accessibilityRole="progressbar"
        accessibilityLabel={`Downloading ${item.name}`}
        accessibilityValue={{ min: 0, max: 100, now: percent }}
      >
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { position: "absolute", left: space(4), right: space(4), bottom: space(4) },
  panel: {
    flexGrow: 0,
    maxHeight: space(72),
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadowRaised,
  },
  rows: { gap: space(3), padding: space(3) },
  row: { gap: space(1.5) },
  line: { flexDirection: "row", alignItems: "center", gap: space(2) },
  name: { flex: 1 },
  track: {
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    overflow: "hidden",
  },
  fill: { height: 4, backgroundColor: colors.primary },
});
