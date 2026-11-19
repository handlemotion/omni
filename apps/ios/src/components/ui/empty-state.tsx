import type { ComponentType, ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/** A list with nothing in it: a glyph, a title, and at most one action. No explanation. */
export function EmptyState(props: {
  icon: ComponentType<SvgProps & { size?: number }>;
  title: string;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <View style={styles.empty}>
      <Icon size={40} color={colors.subtleForeground} />
      <Text size="lg" tone="mutedForeground" style={styles.title}>
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space(4),
    paddingHorizontal: space(10),
    paddingBottom: space(20),
  },
  title: { textAlign: "center" },
});
