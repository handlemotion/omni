import * as Haptics from "expo-haptics";
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Swipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import type { SvgProps } from "react-native-svg";
import { Text } from "@/components/ui/text.tsx";
import { colors, gutter, iconSize, space, type ColorToken } from "@/theme/tokens.ts";

/** What a full swipe does, drawn under the row as it slides away. */
export interface SwipeAction {
  label: string;
  icon: ComponentType<SvgProps & { size?: number }>;
  tone: "success" | "warning" | "danger" | "primary";
  run: () => void;
}

export interface SwipeRowProps {
  /** Swiping the row to the right. */
  right?: SwipeAction | null;
  /** Swiping the row to the left. */
  left?: SwipeAction | null;
  /** The item the row shows: a list recycles rows, and a new item starts closed. */
  itemKey: string;
  /** Slide back once the action ran (a list row); off for a screen that leaves as it runs. */
  settles?: boolean;
  /** Take the room left on the screen: a whole conversation that swipes. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

const FOREGROUND = {
  success: "successForeground",
  warning: "warningForeground",
  danger: "dangerForeground",
  primary: "primaryForeground",
} as const satisfies Record<SwipeAction["tone"], ColorToken>;

const FULL_SWIPE_TRIGGER = 96;
const ROW_REMOVAL_GRACE_MS = 450;

/**
 * A row that runs an action when swiped all the way across, as Mail and Files do: the action's
 * colour, icon and label show underneath as it slides, and letting go past the trigger carries
 * the row off and runs it. A row with nothing to swipe is just its children.
 */
export function SwipeRow({
  right,
  left,
  itemKey,
  settles = true,
  fill = false,
  style,
  children,
}: SwipeRowProps) {
  const ref = useRef<SwipeableMethods>(null);
  useEffect(() => () => ref.current?.reset(), [itemKey]);
  if (!right && !left)
    return fill ? <View style={[styles.fill, style]}>{children}</View> : children;
  const open = (direction: SwipeDirection) => {
    const action = direction === SwipeDirection.RIGHT ? right : left;
    if (!action) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    action.run();
    if (settles) setTimeout(() => ref.current?.close(), ROW_REMOVAL_GRACE_MS);
  };
  return (
    <Swipeable
      ref={ref}
      friction={1}
      leftThreshold={FULL_SWIPE_TRIGGER}
      rightThreshold={FULL_SWIPE_TRIGGER}
      dragOffsetFromLeft={space(4)}
      dragOffsetFromRight={-space(4)}
      containerStyle={[fill ? styles.fill : null, style]}
      childrenContainerStyle={[styles.content, fill ? styles.fill : null]}
      onSwipeableWillOpen={open}
      renderLeftActions={
        right ? (progress) => <Panel action={right} progress={progress} edge="start" /> : undefined
      }
      renderRightActions={
        left ? (progress) => <Panel action={left} progress={progress} edge="end" /> : undefined
      }
    >
      {children}
    </Swipeable>
  );
}

function Panel({
  action,
  progress,
  edge,
}: {
  action: SwipeAction;
  progress: SharedValue<number>;
  edge: "start" | "end";
}) {
  const Icon = action.icon;
  const ink = FOREGROUND[action.tone];
  const shown = useAnimatedStyle(() => ({ opacity: progress.value > 0 ? 1 : 0 }));
  const grow = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.08], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(progress.value, [0, 0.25], [0.8, 1], Extrapolation.CLAMP) }],
  }));
  return (
    <Animated.View
      style={[
        styles.panel,
        { backgroundColor: colors[action.tone] },
        edge === "start" ? styles.start : styles.end,
        shown,
      ]}
    >
      <Animated.View style={[styles.label, grow]}>
        <Icon size={iconSize.lg} color={colors[ink]} />
        <Text size="caption" weight="medium" tone={ink}>
          {action.label}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  content: { backgroundColor: colors.background },
  fill: { flex: 1 },
  panel: { flex: 1, justifyContent: "center", paddingHorizontal: gutter },
  start: { alignItems: "flex-start" },
  end: { alignItems: "flex-end" },
  label: { alignItems: "center", gap: space(1) },
});
