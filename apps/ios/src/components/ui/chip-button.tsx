import type { ComponentType, ReactNode } from "react";
import { Pressable, StyleSheet, type PressableProps } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/** A chip's height: a recipient, an attachment. */
export const chipHeight = space(8);

export interface ChipButtonProps extends Omit<PressableProps, "children" | "style"> {
  label: string;
  /** Before the label: a 24pt circle (an avatar) in a chip, anything round. */
  lead?: ReactNode;
  /** Before the label in place of `lead`: a small muted glyph (a list's sort or filter). */
  icon?: ComponentType<SvgProps & { size?: number }>;
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
  /** The chip picked among its row (a list's filter, a board's stage): the accent fill. */
  isSelected?: boolean;
}

/**
 * A small pressable label with an optional lead and trailing mark, at the composer's 15pt:
 * a recipient chip, the From picker, a row's text action. Squeezes to 0.97 while pressed.
 */
export function ChipButton({
  label,
  lead,
  icon: Icon,
  trailing,
  variant = "inline",
  tone = "foreground",
  isPending = false,
  isSelected = false,
  ...props
}: ChipButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      {...props}
      style={({ pressed }) => [
        styles.base,
        variant === "chip" ? styles.chip : styles.inline,
        variant === "chip" && !lead && styles.chipNoLead,
        variant === "chip" && Icon && styles.chipGlyph,
        isSelected && styles.selected,
        isPending && styles.dimmed,
        pressed && styles.pressed,
      ]}
    >
      {Icon ? <Icon size={iconSize.sm} color={colors.mutedForeground} /> : lead}
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
  chipGlyph: { gap: space(1.5), paddingLeft: space(2.5) },
  inline: { gap: space(1.5), minHeight: space(11) },
  label: { flexShrink: 1, minWidth: 0 },
  selected: { backgroundColor: colors.accent, borderColor: colors.accent },
  dimmed: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.97 }] },
});
