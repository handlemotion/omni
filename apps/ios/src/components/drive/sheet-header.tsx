import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text.tsx";
import { space } from "@/theme/tokens.ts";

/** A Drive sheet's top: its title, and at most one action on the right. */
export function SheetHeader(props: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.header}>
      <Text size="lg" weight="semibold" numberOfLines={1} style={styles.title}>
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingTop: space(6),
    paddingBottom: space(3),
    paddingHorizontal: space(4),
  },
  title: { flex: 1 },
});
