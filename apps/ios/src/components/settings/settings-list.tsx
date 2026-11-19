import { Children, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { colors, radius, space } from "@/theme/tokens.ts";

/** A grouped list's section, as iOS Settings draws one: a title over rows in a rounded card. */
export function SettingsSection(props: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(props.children);
  return (
    <View style={styles.section}>
      {props.title ? (
        <Text size="sm" weight="medium" tone="mutedForeground" style={styles.title}>
          {props.title}
        </Text>
      ) : null}
      <View style={styles.group}>
        {rows.map((row, index) => (
          <View key={index}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {row}
          </View>
        ))}
      </View>
    </View>
  );
}

/** One row: a label, then its value or a control at the end. Tappable when it has `onPress`. */
export function SettingsRow(props: {
  label: string;
  /** Under the label, muted: an inbox's sync state, your email. */
  detail?: string | null;
  value?: string | null;
  control?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <PressableRow
      onPress={props.onPress}
      style={styles.row}
      accessibilityLabel={props.accessibilityLabel}
    >
      <View style={styles.label}>
        <Text numberOfLines={1} tone={props.destructive ? "danger" : "foreground"}>
          {props.label}
        </Text>
        {props.detail ? (
          <Text size="sm" tone="mutedForeground" numberOfLines={1}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.value ? (
        <Text tone="mutedForeground" numberOfLines={1} style={styles.value}>
          {props.value}
        </Text>
      ) : null}
      {props.control}
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  section: { gap: space(2) },
  title: { paddingHorizontal: space(4) },
  group: {
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: "hidden",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: space(4),
  },
  row: { alignItems: "center", minHeight: 48 },
  label: { flexShrink: 1, gap: space(0.5) },
  value: { flex: 1, textAlign: "right" },
});
