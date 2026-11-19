import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconArrowRotateClockwise, IconX } from "@/components/icons.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { canRetryUpload, driveErrorText } from "@/lib/drive-actions.ts";
import { removeUpload, retryUpload, useUploads, type UploadItem } from "@/lib/drive-uploads.ts";
import { colors, radius, shadowRaised, space } from "@/theme/tokens.ts";

/**
 * Uploads on their way, over the bottom of Drive's screens: a name, how far it is, Cancel; a
 * failed one says why, with Retry when another try may work. The web's uploads panel.
 */
export function UploadsPanel() {
  const uploads = useUploads();
  if (!uploads.length) return null;
  return (
    <SafeAreaView edges={["bottom"]} style={styles.dock} pointerEvents="box-none">
      <ScrollView style={styles.panel} contentContainerStyle={styles.rows}>
        {uploads.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ item }: { item: UploadItem }) {
  const failed = item.status === "failed";
  const percent = item.size ? Math.floor((item.sent / item.size) * 100) : 0;
  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <Text size="sm" numberOfLines={1} style={styles.name}>
          {item.name}
        </Text>
        {failed ? null : (
          <Text size="sm" tone="mutedForeground" tabular>
            {percent}%
          </Text>
        )}
        {failed && canRetryUpload(item.error) ? (
          <IconButton
            icon={IconArrowRotateClockwise}
            label={`Retry ${item.name}`}
            onPress={() => retryUpload(item.id)}
          />
        ) : null}
        <IconButton
          icon={IconX}
          label={failed ? `Remove ${item.name}` : `Cancel ${item.name}`}
          onPress={() => removeUpload(item.id)}
        />
      </View>
      {failed ? (
        <Text size="xs" tone="mutedForeground" numberOfLines={1}>
          {driveErrorText(item.error, "Not uploaded")}
        </Text>
      ) : (
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={`Uploading ${item.name}`}
          accessibilityValue={{ min: 0, max: 100, now: percent }}
        >
          <View style={[styles.fill, { width: `${percent}%` }]} />
        </View>
      )}
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
