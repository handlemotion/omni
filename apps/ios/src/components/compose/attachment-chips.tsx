import { StyleSheet, View } from "react-native";
import { IconCircleAlert, IconX } from "@/components/icons.ts";
import { ChipButton } from "@/components/ui/chip-button.tsx";
import type { ComposeAttachment } from "@/lib/compose-attachments.ts";
import { colors, gutter, iconSize, space } from "@/theme/tokens.ts";

/**
 * The files on a message, under what it says: hairline chips with the file's name, dimmed while
 * uploading, an alert mark when the upload failed. A tap takes one off.
 */
export function AttachmentChips({
  list,
  onRemove,
}: {
  list: ComposeAttachment[];
  onRemove: (key: string) => void;
}) {
  if (!list.length) return null;
  return (
    <View style={styles.chips}>
      {list.map((one) => {
        const failed = one.state === "failed";
        const Mark = failed ? IconCircleAlert : IconX;
        return (
          <ChipButton
            key={one.key}
            variant="chip"
            label={one.file.name}
            tone={failed ? "mutedForeground" : "foreground"}
            isPending={one.state === "uploading"}
            accessibilityLabel={`Remove ${one.file.name}`}
            trailing={<Mark size={iconSize.sm} color={colors.mutedForeground} />}
            onPress={() => onRemove(one.key)}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space(2),
    paddingHorizontal: gutter,
    paddingBottom: gutter,
  },
});
