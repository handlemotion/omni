import type { ComponentType, ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, floatingControl, iconSize, radius, searchControl, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

export const compactControl = space(11);

type Glyph = ComponentType<SvgProps & { size?: number }>;

export interface FloatingButtonProps extends Omit<PressableProps, "children" | "style"> {
  icon: Glyph;
  /** What VoiceOver reads: name the action. */
  label: string;
  /** `primary`: the brand fill, for the page's main action (New message). */
  primary?: boolean;
  /** 44pt instead of 50: a control in a page's top row (the menu's Settings). */
  compact?: boolean;
  /** 48pt: beside the open search field. */
  searching?: boolean;
  /** The glyph's size; 20pt unless set. */
  glyph?: number;
  /** The action is running (Send): dimmed like a disabled button, a spinner in the glyph's place. */
  isPending?: boolean;
}

/**
 * A round button floating over the page, at the bottom: flat, the surface fill and a hairline
 * edge, or the brand fill for the main action. Squeezes to 0.97 while pressed (tactile-design).
 */
export function FloatingButton({
  icon: Icon,
  label,
  primary = false,
  compact = false,
  searching = false,
  glyph = iconSize.md,
  isPending = false,
  disabled,
  ...props
}: FloatingButtonProps) {
  const ink = primary ? colors.primaryForeground : colors.foreground;
  return (
    <Pressable
      {...props}
      disabled={disabled || isPending}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || isPending), busy: isPending }}
      style={({ pressed }) => [
        styles.surface,
        styles.round,
        primary && styles.primary,
        compact && styles.compactRound,
        searching && styles.searchRound,
        (disabled || isPending) && styles.dimmed,
        pressed && styles.pressed,
      ]}
    >
      {isPending ? <ActivityIndicator color={ink} /> : <Icon size={glyph} color={ink} />}
    </Pressable>
  );
}

/**
 * The floating bar's wide pill, at rest: a glyph and the field's placeholder; a tap opens the
 * field (`FloatingField`).
 */
export function FloatingPill({
  icon: Icon,
  label,
  compact = false,
  onPress,
}: {
  icon: Glyph;
  label: string;
  compact?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.surface,
        styles.pill,
        compact && styles.compact,
        pressed && styles.pressed,
      ]}
    >
      <Icon size={iconSize.field} color={colors.mutedForeground} />
      <Text size="body" tone="mutedForeground" numberOfLines={1} style={styles.shrink}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The pill holding a live field: the glyph, then `children` (a bare `TextField`). */
export function FloatingField({ icon: Icon, children }: { icon: Glyph; children: ReactNode }) {
  return (
    <View style={[styles.surface, styles.pill, styles.field]}>
      <Icon size={iconSize.field} color={colors.mutedForeground} />
      {children}
    </View>
  );
}

export interface FloatingGroupAction {
  icon: Glyph;
  /** What VoiceOver reads: name the action. */
  label: string;
  onPress?: () => void;
}

/**
 * Related actions in one floating pill (a conversation's Reply, Reply all, Forward): flat, the
 * surface fill and a hairline edge, each a 44pt glyph. One without `onPress` is dimmed.
 */
export function FloatingGroup({ actions }: { actions: FloatingGroupAction[] }) {
  return (
    <View style={[styles.surface, styles.group]}>
      {actions.map(({ icon: Icon, label, onPress }) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: !onPress }}
          disabled={!onPress}
          onPress={onPress}
          style={({ pressed }) => [
            styles.groupButton,
            !onPress && styles.dimmed,
            pressed && styles.pressed,
          ]}
        >
          <Icon size={iconSize.md} color={colors.foreground} />
        </Pressable>
      ))}
    </View>
  );
}

/** A flat card floating over the page (the module menu): surface, hairline edge, no shadow. */
export function FloatingCard({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  surface: {
    height: floatingControl,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  round: { width: floatingControl, alignItems: "center", justifyContent: "center" },
  compact: { height: compactControl },
  compactRound: { width: compactControl, height: compactControl },
  searchRound: { width: searchControl, height: searchControl },
  field: { height: searchControl, paddingHorizontal: space(4) },
  primary: { backgroundColor: colors.primaryButton, borderWidth: 0 },
  pill: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    paddingHorizontal: space(4.5),
  },
  card: {
    gap: space(0.5),
    padding: space(1.5),
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  group: { flexDirection: "row", alignItems: "center", paddingHorizontal: space(1.5) },
  groupButton: {
    width: compactControl,
    height: compactControl,
    alignItems: "center",
    justifyContent: "center",
  },
  dimmed: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.97 }] },
  shrink: { flexShrink: 1 },
});
