import type { ComponentType } from "react";
import { Pressable, StyleSheet, type PressableProps } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

export interface IconButtonProps extends Omit<PressableProps, "children"> {
  icon: ComponentType<SvgProps & { size?: number }>;
  /** What VoiceOver reads: name the action, the glyph is decorative. */
  label: string;
  /** `toolbar`: a 44pt target and a 20pt glyph, as a composer's bottom toolbar draws them. */
  size?: "md" | "toolbar";
  /** The glyph's ink at rest: muted unless it is a toolbar's main tool. */
  tone?: "mutedForeground" | "foreground";
}

/** A glyph you can press, with a 44pt touch target. Muted at rest, foreground while pressed. */
export function IconButton({
  icon: Icon,
  label,
  size = "md",
  tone = "mutedForeground",
  style,
  ...props
}: IconButtonProps) {
  const toolbar = size === "toolbar";
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={(state) => [
        styles.button,
        toolbar && styles.toolbar,
        state.pressed && styles.pressed,
        typeof style === "function" ? style(state) : style,
      ]}
    >
      {({ pressed }) => (
        <Icon
          size={toolbar ? iconSize.md : iconSize.lg}
          color={pressed ? colors.foreground : colors[tone]}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbar: { width: space(11), height: space(11) },
  pressed: { backgroundColor: colors.accent, transform: [{ scale: 0.97 }] },
});
