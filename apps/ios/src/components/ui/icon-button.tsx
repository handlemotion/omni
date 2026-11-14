import type { ComponentType } from "react";
import { Pressable, StyleSheet, type PressableProps } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, iconSize, radius } from "@/theme/tokens.ts";

export interface IconButtonProps extends Omit<PressableProps, "children"> {
  icon: ComponentType<SvgProps & { size?: number }>;
  /** What VoiceOver reads: name the action, the glyph is decorative. */
  label: string;
}

/** A glyph you can press, with a 44pt touch target. Muted at rest, foreground while pressed. */
export function IconButton({ icon: Icon, label, style, ...props }: IconButtonProps) {
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={(state) => [
        styles.button,
        state.pressed && styles.pressed,
        typeof style === "function" ? style(state) : style,
      ]}
    >
      {({ pressed }) => (
        <Icon size={iconSize.lg} color={pressed ? colors.foreground : colors.mutedForeground} />
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
  pressed: { backgroundColor: colors.accent, transform: [{ scale: 0.97 }] },
});
