import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text.tsx";
import { TextField, type TextFieldProps } from "@/components/ui/text-field.tsx";
import { colors, gutter, space } from "@/theme/tokens.ts";

/** One line of a message's header (To, Cc, Subject): its label, then the value, a rule under it. */
export function HeaderRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text tone="mutedForeground" style={styles.label}>
        {label}
      </Text>
      <View style={styles.value}>{children}</View>
    </View>
  );
}

/**
 * A header line you type into. Recipient lines are `multiline` so a long address wraps and the
 * line grows instead of scrolling sideways out of sight.
 */
export function HeaderField({ label, ...props }: TextFieldProps) {
  return (
    <HeaderRow label={label}>
      <TextField
        variant="bare"
        label={label}
        scrollEnabled={false}
        submitBehavior="submit"
        {...props}
      />
    </HeaderRow>
  );
}

/** Addresses: no capitals, no corrections, the email keyboard, wrapped. */
export const addressInput = {
  multiline: true,
  autoCapitalize: "none",
  autoCorrect: false,
  keyboardType: "email-address",
  textContentType: "emailAddress",
  autoComplete: "email",
} as const satisfies Partial<TextFieldProps>;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space(2),
    minHeight: 52,
    paddingHorizontal: gutter,
    paddingVertical: space(3.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { flexShrink: 0 },
  value: { flex: 1, minWidth: 0 },
});
