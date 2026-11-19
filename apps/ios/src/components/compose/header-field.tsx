import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text.tsx";
import { colors, gutter, space } from "@/theme/tokens.ts";

const ROW = space(13);

/**
 * One line of the composer's head, as the web draws it: a short muted label (none for Subject),
 * the value, and a rule under it.
 */
export function HeaderRow({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      {label ? (
        <Text tone="mutedForeground" style={styles.label}>
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
    gap: space(2.5),
    minHeight: ROW,
    paddingHorizontal: gutter,
    paddingVertical: space(1.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { width: space(11), flexShrink: 0 },
});
