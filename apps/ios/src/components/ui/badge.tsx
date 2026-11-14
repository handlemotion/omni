import { StyleSheet, View } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/** A count on a primary-subtle pill: unread threads beside a mailbox. */
export function Badge({ count }: { count: number }) {
  return (
    <View style={styles.badge}>
      <Text size="sm" weight="medium" tone="primary" tabular>
        {count}
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
});
