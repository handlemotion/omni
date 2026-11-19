import type { ComponentType, ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

const INK = {
  foreground: colors.foreground,
  muted: colors.mutedForeground,
} as const;

/**
 * The web's ghost button (`intent="ghost" size="sm"`), scaled to the phone: no fill at rest, a
 * glyph (or `lead`, an avatar) and its label; the accent fill while pressed. `muted` ink is a
 * property not set yet.
 * Without `onPress` it only shows the value.
 */
export function GhostButton({
  icon: Icon,
  lead,
  label,
  tone = "foreground",
  accessibilityLabel,
  onPress,
}: {
  icon?: ComponentType<SvgProps & { size?: number }>;
  lead?: ReactNode;
  label: string;
  tone?: keyof typeof INK;
  accessibilityLabel?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {lead ?? (Icon ? <Icon size={iconSize.field} color={INK[tone]} /> : null)}
      <View style={styles.label}>
        <Text
          size="subhead"
          tone={tone === "muted" ? "mutedForeground" : "foreground"}
          numberOfLines={1}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    height: space(9),
    paddingHorizontal: space(2.5),
    borderRadius: radius.control,
  },
  label: { flexShrink: 1 },
  pressed: { backgroundColor: colors.accent, transform: [{ scale: 0.97 }] },
});
