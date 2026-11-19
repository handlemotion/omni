import type { ComponentType, ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { colors, iconSize, space } from "@/theme/tokens.ts";

/**
 * A row on the menu page: a glyph (or `lead`, an avatar), the label, a count
 * at the end. The current one has the accent fill and its label semibold.
 */
export function MenuRow(props: {
  icon?: ComponentType<SvgProps & { size?: number }>;
  lead?: ReactNode;
  label: string;
  count?: string;
  isCurrent?: boolean;
  /** A folder's glyph is muted; a view's is in the brand's ink. */
  muted?: boolean;
  /** Drawn after the label in place of a count: a check. */
  trailing?: ReactNode;
  onPress: () => void;
}) {
  const Icon = props.icon;
  const current = !!props.isCurrent;
  return (
    <PressableRow
      shape="menu"
      isCurrent={current}
      onPress={props.onPress}
      accessibilityLabel={[props.label, props.count].filter(Boolean).join(", ")}
    >
      <View style={styles.lead}>
        {props.lead ??
          (Icon ? (
            <Icon
              size={iconSize.menu}
              color={props.muted ? colors.mutedForeground : colors.primary}
            />
          ) : null)}
      </View>
      <Text
        size="md"
        weight={current ? "semibold" : "regular"}
        numberOfLines={1}
        style={styles.label}
      >
        {props.label}
      </Text>
      {props.trailing ??
        (props.count ? (
          <Text size="subhead" tone="mutedForeground" tabular>
            {props.count}
          </Text>
        ) : null)}
    </PressableRow>
  );
}

/** A run of menu rows under its label (Views, Folders). */
export function MenuSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View>
      <View style={styles.heading}>
        <Text
          size="subhead"
          weight="medium"
          tone="mutedForeground"
          numberOfLines={1}
          accessibilityRole="header"
        >
          {label}
        </Text>
      </View>
      {children}
    </View>
  );
}

/** How far the menu's rows sit in from the screen's sides. */
export const MENU_INSET = space(1.5);

/** A hairline across the whole menu, edge to edge, between its groups. */
export function MenuDivider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  lead: { width: iconSize.menu, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, minWidth: 0 },
  heading: { height: space(11), justifyContent: "center", paddingHorizontal: space(3.5) },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: space(2),
    marginHorizontal: -MENU_INSET,
    backgroundColor: colors.border,
  },
});
