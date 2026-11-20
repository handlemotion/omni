import { StyleSheet, View } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A count on a primary-subtle pill: unread threads beside a mailbox. With `label` instead, a
 * state on the accent pill in muted ink: a record that is archived.
 */
export function Badge(props: { count: number } | { label: string }) {
  if ("label" in props) {
    return (
      <View style={[styles.badge, styles.neutral]}>
        <Text size="sm" weight="medium" tone="mutedForeground">
          {props.label}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.badge}>
      <Text size="sm" weight="medium" tone="primary" tabular>
        {props.count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    minWidth: 24,
    paddingHorizontal: space(2),
    paddingVertical: space(0.5),
    borderRadius: radius.full,
    backgroundColor: colors.primarySubtle,
    alignItems: "center",
  },
  neutral: { alignSelf: "flex-start", backgroundColor: colors.accent },
});
