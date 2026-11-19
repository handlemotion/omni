import { StyleSheet } from "react-native";
import { gutter, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/** A run of rows' heading in a list: a day, a kind of record. Plain muted words, no rule. */
export function SectionHeading({ label }: { label: string }) {
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

const styles = StyleSheet.create({
  heading: { paddingHorizontal: gutter, paddingTop: space(5), paddingBottom: space(1) },
});
