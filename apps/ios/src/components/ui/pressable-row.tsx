import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";

export interface PressableRowProps {
  children: ReactNode;
  onPress?: () => void;
  /** The item you're on (a list's current mailbox): the accent fill, `selected` for VoiceOver. */
  isCurrent?: boolean;
  /** `list`: edge to edge in a scrolling list. `inset`: a rounded row inside a sheet or menu. */
  shape?: "list" | "inset";
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

/** A tappable row: content laid out in a line, the accent fill while pressed or current. */
export function PressableRow({
  children,
  onPress,
  isCurrent = false,
  shape = "list",
  accessibilityLabel,
  accessibilityHint,
  style,
}: PressableRowProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: isCurrent }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        styles.row,
        shape === "inset" ? styles.inset : styles.list,
        (pressed || isCurrent) && styles.highlighted,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space(3) },
  list: {
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    backgroundColor: colors.background,
  },
  inset: {
    alignItems: "center",
    minHeight: 52,
    paddingHorizontal: space(3),
    paddingVertical: space(2),
    borderRadius: radius.field,
  },
  highlighted: { backgroundColor: colors.accent },
});
