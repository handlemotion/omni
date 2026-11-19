import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

export interface ButtonProps extends Omit<PressableProps, "children"> {
  label: string;
  /** `primary` filled brand, `plain` a well, `quiet` text only (a secondary action in place). */
  intent?: "primary" | "plain" | "quiet";
  size?: "md" | "lg";
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
  style,
  ...props
}: ButtonProps) {
  const primary = intent === "primary";
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || isPending), busy: !!isPending }}
      disabled={disabled || isPending}
      style={(state) => [
        styles.base,
        size === "lg" ? styles.lg : styles.md,
        intent === "quiet" ? styles.quiet : primary ? styles.primary : styles.plain,
        (disabled || isPending) && styles.dimmed,
        state.pressed && styles.pressed,
        typeof style === "function" ? style(state) : style,
      ]}
    >
      <View style={styles.row}>
        {isPending ? (
          <ActivityIndicator color={primary ? colors.primaryForeground : colors.foreground} />
        ) : null}
        <Text
          weight="medium"
          tone={primary ? "primaryForeground" : "foreground"}
          numberOfLines={1}
          style={styles.label}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  md: { minHeight: 48, paddingHorizontal: space(5) },
  lg: { minHeight: 56, paddingHorizontal: space(6) },
  primary: {
    backgroundColor: colors.primaryButton,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  plain: { backgroundColor: colors.well },
  quiet: { minHeight: 36, paddingHorizontal: 0, alignSelf: "flex-start" },
  dimmed: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.97 }] },
  row: { flexDirection: "row", alignItems: "center", gap: space(2), maxWidth: "100%" },
  label: { flexShrink: 1 },
});
