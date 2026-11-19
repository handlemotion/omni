import { useMemo, type ComponentType } from "react";
import { PanResponder, Pressable, StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { IconChevronLeft, IconChevronRight } from "@/components/icons.ts";
import { colors, radius, space, type ColorToken } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * Which of a pager's pages is showing: a small flat pill with the page's glyph and name, between
 * a muted chevron each way (dimmed and disabled where there is no page that way). A chevron
 * pages to its neighbour; so does a sideways swipe on the pill.
 */
export function PagePill({
  icon: Icon,
  tile,
  label,
  count,
  index,
  onPick,
  labels,
}: {
  icon: ComponentType<SvgProps & { size?: number }>;
  /** The page's mark: its glyph in white on this colour's tile. */
  tile: ColorToken;
  label: string;
  count: number;
  index: number;
  onPick: (index: number) => void;
  /** What VoiceOver reads for each chevron: the page it goes to. */
  labels: readonly string[];
}) {
  const swipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderRelease: (_, g) => {
          if (Math.abs(g.dx) < SWIPE) return;
          const to = index + (g.dx < 0 ? 1 : -1);
          if (to >= 0 && to < count) onPick(to);
        },
      }),
    [index, count, onPick],
  );
  return (
    <View style={styles.row}>
      <Step icon={IconChevronLeft} to={index - 1} count={count} labels={labels} onPick={onPick} />
      <View style={styles.pill} {...swipe.panHandlers}>
        <View style={[styles.tile, { backgroundColor: colors[tile] }]}>
          <Icon size={space(4)} color={colors.moduleForeground} />
        </View>
        <Text size="subhead" weight="semibold">
          {label}
        </Text>
      </View>
      <Step icon={IconChevronRight} to={index + 1} count={count} labels={labels} onPick={onPick} />
    </View>
  );
}

function Step({
  icon: Icon,
  to,
  count,
  labels,
  onPick,
}: {
  icon: ComponentType<SvgProps & { size?: number }>;
  to: number;
  count: number;
  labels: readonly string[];
  onPick: (index: number) => void;
}) {
  const off = to < 0 || to >= count;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={labels[to]}
      accessibilityState={{ disabled: off }}
      disabled={off}
      hitSlop={space(3)}
      onPress={() => onPick(to)}
      style={styles.step}
    >
      <Icon size={space(4)} color={off ? colors.hairlineLine : colors.mutedForeground} />
    </Pressable>
  );
}

const SWIPE = space(6);

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", alignSelf: "center", gap: space(1) },
  step: { width: space(5), alignItems: "center", justifyContent: "center" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
    height: space(10),
    paddingLeft: space(2),
    paddingRight: space(3.5),
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  tile: {
    width: space(6),
    height: space(6),
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
});
