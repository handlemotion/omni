import { StyleSheet, View } from "react-native";
import { colors, gutter, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A run of rows' heading in a list: a day, a kind of record. Plain muted words, no rule. A
 * `group` (the inbox's Today, Yesterday) reads dark and regular, Spark's way: the label, a count at the
 * other gutter when given, 44pt tall over an edge-to-edge hairline.
 */
export function SectionHeading({
  label,
  count,
  variant = "muted",
}: {
  label: string;
  count?: string;
  variant?: "muted" | "group";
}) {
  if (variant === "muted") {
    return (
      <Text
        size="sm"
        weight="medium"
        tone="mutedForeground"
        accessibilityRole="header"
        numberOfLines={1}
        style={styles.heading}
      >
        {label}
      </Text>
    );
  }
  return (
    <View accessibilityRole="header" accessible style={[styles.heading, styles.group]}>
      <Text size="subhead" numberOfLines={1} style={styles.grow}>
        {label}
      </Text>
      {count ? (
        <Text size="caption" tone="subtleForeground" tabular>
          {count}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { paddingHorizontal: gutter, paddingTop: space(5), paddingBottom: space(1) },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    height: space(11),
    paddingTop: 0,
    paddingBottom: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  grow: { flex: 1, minWidth: 0 },
});
