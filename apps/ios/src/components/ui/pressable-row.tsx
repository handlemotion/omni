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
  /**
   * `list`: edge to edge in a scrolling list. `inset`: a rounded row inside a sheet or menu.
   * `menu`: a shorter inset row, a glyph and a label: the menu page's. `bare`: no padding and no
   * fill, its content top-aligned: a header that opens and closes what is under it.
   */
  shape?: "list" | "inset" | "menu" | "bare";
  /** What it opens is showing: `expanded` for VoiceOver. Left out, it opens nothing. */
  isExpanded?: boolean;
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
  isExpanded,
  style,
  ...props
}: PressableRowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      onPress={onPress}
      disabled={!onPress}
      accessibilityState={{ selected: isCurrent, expanded: isExpanded }}
      style={({ pressed }) => [
        styles.row,
        styles[shape],
        shape !== "bare" && (pressed || isCurrent) && styles.highlighted,
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
  menu: {
    alignItems: "center",
    gap: space(3.5),
    minHeight: space(12.5),
    paddingHorizontal: space(3.5),
    borderRadius: radius.row,
  },
  bare: { alignItems: "flex-start", gap: space(3) },
  highlighted: { backgroundColor: colors.accent },
});
