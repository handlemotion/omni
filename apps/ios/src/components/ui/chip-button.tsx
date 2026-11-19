import type { ReactNode } from "react";
import { Pressable, StyleSheet, type PressableProps } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/** A chip's height: a recipient, an attachment. */
export const chipHeight = space(8);

export interface ChipButtonProps extends Omit<PressableProps, "children" | "style"> {
  label: string;
  /** Before the label: a 24pt circle (an avatar) in a chip, anything round. */
  lead?: ReactNode;
  /** After the label: a chevron for a picker. */
  trailing?: ReactNode;
  /**
   * `chip`: a 32pt pill with a hairline edge and no fill, its lead inset 4pt (a recipient).
   * `inline`: the label and its marks alone, no frame (the composer's From).
   */
  variant?: "chip" | "inline";
  /** `mutedForeground` for a secondary action in a row (Cc Bcc). */
  tone?: "foreground" | "mutedForeground";
  /** Working on it (an upload): dimmed until it settles. */
  isPending?: boolean;
}

/**
 * A small pressable label with an optional lead and trailing mark, at the composer's 15pt:
 * a recipient chip, the From picker, a row's text action. Squeezes to 0.97 while pressed.
 */
export function ChipButton({
  label,
  lead,
  trailing,
  variant = "inline",
  tone = "foreground",
  isPending = false,
  ...props
}: ChipButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      {...props}
      style={({ pressed }) => [
        styles.base,
        variant === "chip" ? styles.chip : styles.inline,
        variant === "chip" && !lead && styles.chipNoLead,
        isPending && styles.dimmed,
        pressed && styles.pressed,
      ]}
    >
      {lead}
      <Text size="subhead" tone={tone} numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: "row", alignItems: "center", maxWidth: "100%" },
  chip: {
    height: chipHeight,
    gap: space(2),
    paddingLeft: space(1),
    paddingRight: space(3),
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipNoLead: { paddingLeft: space(3) },
  inline: { gap: space(1.5), minHeight: space(11) },
  label: { flexShrink: 1, minWidth: 0 },
  dimmed: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.97 }] },
});
