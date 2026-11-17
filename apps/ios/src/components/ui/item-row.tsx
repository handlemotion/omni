import type { ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import { PressableRow } from "./pressable-row.tsx";
import { Text } from "./text.tsx";

/** A one-line list row: a glyph in a tile, a title, a muted detail under it, a trailing note. */
export function ItemRow(props: {
  icon: ComponentType<SvgProps & { size?: number }>;
  title: string;
  detail?: string | null;
  trailing?: string | null;
  onPress?: () => void;
}) {
  const Icon = props.icon;
  return (
    <PressableRow onPress={props.onPress} style={styles.row}>
      <View style={styles.tile}>
        <Icon size={iconSize.md} color={colors.mutedForeground} />
      </View>
      <View style={styles.body}>
        <Text numberOfLines={1}>{props.title}</Text>
        {props.detail ? (
          <Text size="sm" tone="mutedForeground" numberOfLines={1}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.trailing ? (
        <Text size="sm" tone="mutedForeground" tabular>
          {props.trailing}
        </Text>
      ) : null}
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: "center" },
  tile: {
    width: 32,
    height: 32,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: space(0.5) },
});
