import type { ComponentType, ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { IconChevronRight } from "@/components/icons.ts";
import { colors, iconSize, space, type ColorToken } from "@/theme/tokens.ts";

const NAV_LEAD = space(11);

/**
 * A row on the menu page (`nav`) or in a sheet: a glyph (or `lead`, an avatar), the label, a
 * count or a detail at the end. The current one has the accent fill and its label semibold.
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
  /** The glyph's column width, so a sheet's glyphs line up with its avatars. */
  leadWidth?: number;
  /** The label and glyph in the brand's ink (an action like Upgrade). */
  accent?: boolean;
  /** The label and glyph in red: an action that throws something away. */
  destructive?: boolean;
  /** The glyph's colour, over `muted`: a module's own (Drive's green, the CRM's purple). */
  tint?: ColorToken;
  /** On the menu page: the glyph in a 44pt column under the top bar's ☰. */
  nav?: boolean;
  /** Muted text before the end (a Later choice's time). */
  detail?: string;
  /** A chevron at the end: the row opens more choices. */
  chevron?: boolean;
  onPress: () => void;
}) {
  const Icon = props.icon;
  const current = !!props.isCurrent;
  const ink: ColorToken = props.destructive
    ? "danger"
    : props.accent
      ? "primary"
      : (props.tint ?? (props.muted ? "mutedForeground" : "primary"));
  return (
    <PressableRow
      shape={props.nav ? "nav" : "menu"}
      isCurrent={current}
      onPress={props.onPress}
      accessibilityLabel={[props.label, props.count].filter(Boolean).join(", ")}
    >
      <View
        style={[
          styles.lead,
          props.nav ? styles.navLead : null,
          props.leadWidth ? { width: props.leadWidth } : null,
        ]}
      >
        {props.lead ?? (Icon ? <Icon size={iconSize.menu} color={colors[ink]} /> : null)}
      </View>
      <Text
        size="md"
        weight={current ? "semibold" : "regular"}
        tone={props.destructive ? "danger" : props.accent ? "primary" : "foreground"}
        numberOfLines={1}
        style={styles.label}
      >
        {props.label}
      </Text>
      {props.detail || props.count ? (
        <Text size="subhead" tone="mutedForeground" tabular>
          {props.detail ?? props.count}
        </Text>
      ) : null}
      {props.trailing ??
        (props.chevron ? (
          <IconChevronRight size={space(4)} color={colors.mutedForeground} />
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
export const MENU_INSET = space(2.5);

const SHEET_INSET = space(1.5);

/** A hairline across the whole menu, edge to edge, between its groups. */
export function MenuDivider() {
  return <View style={styles.divider} />;
}

/** A hairline across a whole sheet, edge to edge, between its groups of rows. */
export function SheetDivider() {
  return <View style={styles.sheetDivider} />;
}

const styles = StyleSheet.create({
  lead: { width: iconSize.menu, alignItems: "center", justifyContent: "center" },
  navLead: { width: NAV_LEAD },
  label: { flex: 1, minWidth: 0 },
  heading: { height: space(11), justifyContent: "center", paddingHorizontal: space(4.25) },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: space(2),
    marginHorizontal: -MENU_INSET,
    backgroundColor: colors.border,
  },
  sheetDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: space(1.5),
    marginHorizontal: -SHEET_INSET,
    backgroundColor: colors.border,
  },
});
