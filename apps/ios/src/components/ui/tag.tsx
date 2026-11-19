import { Pressable, StyleSheet } from "react-native";
import { IconX } from "@/components/icons.ts";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/** The web's removable `Tag`: a label on the accent pill and an ×. Tapping it removes it. */
export function Tag({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove ${label}`}
      onPress={onRemove}
      style={({ pressed }) => [styles.tag, pressed && styles.pressed]}
    >
      <Text size="sm" numberOfLines={1} ellipsizeMode="middle" style={styles.label}>
        {label}
      </Text>
      <IconX size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    maxWidth: "100%",
    paddingHorizontal: space(2.5),
    paddingVertical: space(1),
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  pressed: { backgroundColor: colors.well },
  label: { flexShrink: 1, minWidth: 0 },
});
