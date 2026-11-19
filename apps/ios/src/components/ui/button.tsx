import type { ComponentType } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, iconSize, radius, shadowRaised, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

export interface ButtonProps extends Omit<PressableProps, "children"> {
  label: string;
  /**
   * `primary` filled brand, `plain` a well, `outline` the web's bordered button on the canvas,
   * `quiet` text only (a secondary action in place).
   */
  intent?: "primary" | "plain" | "outline" | "quiet";
  /** `sm` is the web's `sm`, scaled to the phone: a toolbar's buttons. */
  size?: "sm" | "md" | "lg";
  /** A glyph before the label, as the web's leading `<Icon />`. */
  icon?: ComponentType<SvgProps & { size?: number }>;
  /** A glyph after the label: a menu's chevron. */
  trailingIcon?: ComponentType<SvgProps & { size?: number }>;
  /** The action is running: dimmed like a disabled button, a spinner beside the label. */
  isPending?: boolean;
}

/** A labelled action. Squeezes to 0.97 while pressed (tactile-design). */
export function Button({
  label,
  intent = "primary",
  size = "md",
  isPending,
  disabled,
  icon: Icon,
  trailingIcon: Trailing,
  style,
  ...props
}: ButtonProps) {
  const primary = intent === "primary";
  const glyph = primary ? colors.primaryForeground : colors.mutedForeground;
  const glyphSize = size === "sm" ? iconSize.sm : iconSize.md;
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || isPending), busy: !!isPending }}
      disabled={disabled || isPending}
      style={(state) => [
        styles.base,
        styles[size],
        styles[intent],
        (disabled || isPending) && styles.dimmed,
        state.pressed && styles.pressed,
        typeof style === "function" ? style(state) : style,
      ]}
    >
      <View style={styles.row}>
        {isPending ? (
          <ActivityIndicator color={primary ? colors.primaryForeground : colors.foreground} />
        ) : Icon ? (
          <Icon size={glyphSize} color={glyph} />
        ) : null}
        <Text
          size={size === "sm" ? "sm" : "md"}
          weight="medium"
          tone={primary ? "primaryForeground" : "foreground"}
          numberOfLines={1}
          style={styles.label}
        >
          {label}
        </Text>
        {Trailing ? <Trailing size={glyphSize} color={glyph} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  sm: { minHeight: 36, paddingHorizontal: space(3.5) },
  md: { minHeight: 48, paddingHorizontal: space(5) },
  lg: { minHeight: 56, paddingHorizontal: space(6) },
  primary: {
    backgroundColor: colors.primaryButton,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  plain: { backgroundColor: colors.well },
  outline: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadowRaised,
  },
  quiet: { minHeight: 36, paddingHorizontal: 0, alignSelf: "flex-start" },
  dimmed: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.97 }] },
  row: { flexDirection: "row", alignItems: "center", gap: space(2), maxWidth: "100%" },
  label: { flexShrink: 1 },
});
