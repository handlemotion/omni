import type { ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, gutter, radius, space } from "@/theme/tokens.ts";

export interface PressableRowProps extends Omit<PressableProps, "children" | "style"> {
  children: ReactNode;
  /** The item you're on (a list's current mailbox): the accent fill, `selected` for VoiceOver. */
  isCurrent?: boolean;
  /** `list`: edge to edge in a scrolling list. `inset`: a rounded row inside a sheet or menu. */
  shape?: "list" | "inset";
  style?: StyleProp<ViewStyle>;
}

/**
 * A tappable row: content laid out in a line, the accent fill while pressed or current. Takes the
 * rest of `Pressable`'s props, so a native `Link` can wrap it (`asChild`) for preview and menu.
 */
export function PressableRow({
  children,
  onPress,
  isCurrent = false,
  shape = "list",
  style,
  ...props
}: PressableRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      onPress={onPress}
      disabled={!onPress}
      accessibilityState={{ selected: isCurrent }}
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
  row: { flexDirection: "row", gap: space(3.5) },
  list: {
    paddingHorizontal: gutter,
    paddingVertical: space(3.5),
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
