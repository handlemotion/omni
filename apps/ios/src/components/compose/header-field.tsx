import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text.tsx";
import { colors, gutter, space } from "@/theme/tokens.ts";

const ROW_MIN_HEIGHT = space(14);

/**
 * One line of the composer's head: a short muted label at 15pt (none for Subject), the value,
 * and a hairline under it. 56pt at least, 12pt above and below, 20pt from the sides.
 */
export function HeaderRow({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      {label ? (
        <Text size="subhead" tone="mutedForeground" style={styles.label}>
          {label}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: gutter,
    paddingVertical: space(3),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { flexShrink: 0 },
});
