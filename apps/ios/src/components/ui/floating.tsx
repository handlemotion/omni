import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ComponentType, ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, floatingControl, iconSize, radius, searchControl, space } from "@/theme/tokens.ts";
import { Spinner } from "./spinner.tsx";
import { Text } from "./text.tsx";

export const compactControl = space(11);

type Glyph = ComponentType<SvgProps & { size?: number }>;

const HAS_GLASS = isLiquidGlassAvailable();

function GlassSurface({
  style,
  interactive = false,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
  children: ReactNode;
}) {
  if (HAS_GLASS) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="light"
        isInteractive={interactive}
        style={[styles.glass, style]}
      >
        {children}
      </GlassView>
    );
  }
  return <View style={[styles.surface, style]}>{children}</View>;
}

export interface FloatingButtonProps extends Omit<PressableProps, "children" | "style"> {
  icon: Glyph;
  /** What VoiceOver reads: name the action. */
  label: string;
  /** `primary`: the brand fill, for the page's main action (New message). */
  primary?: boolean;
  /** 44pt instead of 48: a control in a page's top row (the menu's Settings). */
  compact?: boolean;
  /** Wider pill shape (54×44) for a top-bar primary action. */
  pill?: boolean;
  /** 44pt: beside the open search field. */
  searching?: boolean;
  /** The glyph's size; 18pt unless set. */
  glyph?: number;
  /** The action is running (Send): dimmed like a disabled button, a spinner in the glyph's place. */
  isPending?: boolean;
}

/**
 * A round button floating over the page: native Liquid Glass on iOS 26+ (or flat white surface
 * with 1pt border elsewhere), or the brand fill for the main action. Squeezes to 0.97 while
 * pressed.
 */
export function FloatingButton({
  icon: Icon,
  label,
  primary = false,
  compact = false,
  pill = false,
  searching = false,
  glyph = iconSize.field,
  isPending = false,
  disabled,
  ...props
}: FloatingButtonProps) {
  const ink = primary ? colors.primaryForeground : colors.foreground;
  const shape = [
    styles.round,
    compact && styles.compactRound,
    pill && styles.pillButton,
    searching && styles.searchRound,
  ];
  const content = isPending ? (
    <Spinner size={glyph} color={ink} />
  ) : (
    <Icon size={glyph} color={ink} />
  );
  return (
    <Pressable
      {...props}
      disabled={disabled || isPending}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || isPending), busy: isPending }}
      style={({ pressed }) => [
        primary && [styles.surface, ...shape, styles.primary],
        (disabled || isPending) && styles.dimmed,
        pressed && styles.pressed,
      ]}
    >
      {primary ? (
        content
      ) : (
        <GlassSurface interactive style={shape}>
          {content}
        </GlassSurface>
      )}
    </Pressable>
  );
}

/**
 * The floating bar's wide search pill, at rest: native Liquid Glass on iOS 26+, with a glyph and
 * placeholder; a tap opens the live field (`FloatingField`).
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
      style={({ pressed }) => [styles.pillWrap, pressed && styles.pressed]}
    >
      <GlassSurface interactive style={[styles.pill, compact && styles.compact]}>
        <Icon size={iconSize.md} strokeWidth={2} color={colors.mutedForeground} />
        <Text size="body" tone="mutedForeground" numberOfLines={1} style={styles.shrink}>
          {label}
        </Text>
      </GlassSurface>
    </Pressable>
  );
}

/** The pill holding a live field: native Liquid Glass, the glyph, then `children` (a bare `TextField`). */
export function FloatingField({ icon: Icon, children }: { icon: Glyph; children: ReactNode }) {
  return (
    <GlassSurface interactive style={[styles.pill, styles.field]}>
      <Icon size={iconSize.md} strokeWidth={2} color={colors.mutedForeground} />
      {children}
    </GlassSurface>
  );
}

export interface FloatingGroupAction {
  icon: Glyph;
  /** What VoiceOver reads: name the action. */
  label: string;
  onPress?: () => void;
}

/**
 * Related actions in one floating pill (a conversation's Reply, Reply all, Forward): native Liquid
 * Glass on iOS 26+, each a 44pt glyph. One without `onPress` is dimmed.
 */
export function FloatingGroup({ actions }: { actions: FloatingGroupAction[] }) {
  return (
    <GlassSurface style={styles.group}>
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
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  glass: {
    height: floatingControl,
    borderRadius: radius.full,
  },
  surface: {
    height: floatingControl,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillWrap: { flex: 1, minWidth: 0 },
  round: { width: floatingControl, alignItems: "center", justifyContent: "center" },
  compact: { height: compactControl },
  compactRound: { width: compactControl, height: compactControl },
  pillButton: { width: space(13.5), height: compactControl },
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
