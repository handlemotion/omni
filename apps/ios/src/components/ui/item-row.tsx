import type { ComponentType, ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, iconSize, radius, rowLead, space } from "@/theme/tokens.ts";
import { PressableRow, type PressableRowProps } from "./pressable-row.tsx";
import { Text } from "./text.tsx";

/**
 * A list row: a lead (an avatar, or a glyph on a tile), a title, a muted detail under it, and a
 * trailing note that never gives up its room. A title truncates at its end, or in its middle
 * (`middle`) for file names, whose extension is the part people read. Takes the rest of
 * `Pressable`'s props, so a native `Link` can wrap it for its menu.
 */
export function ItemRow({
  icon,
  lead,
  title,
  detail,
  trailing,
  ellipsize,
  ...rest
}: Omit<PressableRowProps, "children" | "style"> & {
  icon?: ComponentType<SvgProps & { size?: number }>;
  /** Drawn instead of the glyph tile: an avatar. */
  lead?: ReactNode;
  title: string;
  detail?: string | null;
  trailing?: string | null;
  ellipsize?: "tail" | "middle";
}) {
  const props = { icon, lead, title, detail, trailing, ellipsize };
  const Icon = props.icon;
  return (
    <PressableRow {...rest} style={styles.row}>
      {props.lead ??
        (Icon ? (
          <View style={styles.tile}>
            <Icon size={iconSize.lg} color={colors.mutedForeground} />
          </View>
        ) : null)}
      <View style={styles.body}>
        <Text numberOfLines={props.ellipsize === "middle" ? 1 : 2} ellipsizeMode={props.ellipsize}>
          {props.title}
        </Text>
        {props.detail ? (
          <Text size="sm" tone="mutedForeground" numberOfLines={1}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.trailing ? (
        <Text size="sm" tone="mutedForeground" tabular numberOfLines={1} style={styles.trailing}>
          {props.trailing}
        </Text>
      ) : null}
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: "center" },
  tile: {
    width: rowLead,
    height: rowLead,
    borderRadius: radius.field,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0, gap: space(0.5) },
  trailing: { flexShrink: 0, maxWidth: "40%" },
});
