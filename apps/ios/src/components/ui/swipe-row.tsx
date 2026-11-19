import * as Haptics from "expo-haptics";
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import type { SvgProps } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { Text } from "@/components/ui/text.tsx";
import { colors, iconSize, radius, space, type ColorToken } from "@/theme/tokens.ts";

/** What a full swipe does: the row fills with its colour under its white icon and label. */
export interface SwipeAction {
  label: string;
  icon: ComponentType<SvgProps & { size?: number }>;
  tone: "success" | "warning" | "danger" | "primary";
  run: () => void;
  /**
   * Whether the row leaves the list when it runs (Done, Later, Trash). Off for an action that
   * opens something and leaves the row where it is (Share): the row springs back.
   */
  removes?: boolean;
}

export interface SwipeRowProps {
  /** Swiping the row to the right. */
  right?: SwipeAction | null;
  /** Swiping the row to the left. */
  left?: SwipeAction | null;
  /** The item the row shows: a list recycles rows, and a new item starts in place. */
  itemKey: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

const FILL = {
  success: "swipeDone",
  warning: "swipeLater",
  danger: "danger",
  primary: "primary",
} as const satisfies Record<SwipeAction["tone"], ColorToken>;

const FULL_DRAG = 160;
const COMMIT = 0.6;
const FLING = 800;
const RESIST = 0.15;
const LEAVE_MS = 200;
const COLLAPSE_MS = 220;
const RETURN_MS = 1200;
const SETTLE = { damping: 22, stiffness: 240 } as const;
const tick = () => void Haptics.selectionAsync();

/**
 * A row that runs an action when dragged far enough sideways, the way a conversation's card does:
 * the row itself follows the finger and fills solid (green to the right for Done, grey to the
 * left for Later), reaching full colour at the commit point under a white badge and label; the
 * badge turns solid white once letting go would commit. Letting go there carries the row off the
 * screen and closes the gap it leaves, then runs the action; earlier, it springs back. A row with
 * nothing to swipe is just its children.
 */
export function SwipeRow({ right, left, itemKey, style, children }: SwipeRowProps) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);
  const armed = useSharedValue(0);
  const height = useSharedValue(-1);
  const measured = useSharedValue(0);
  const canRight = useSharedValue(!!right);
  const canLeft = useSharedValue(!!left);
  const back = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    canRight.value = !!right;
    canLeft.value = !!left;
  }, [right, left, canRight, canLeft]);
  useEffect(() => {
    x.value = 0;
    armed.value = 0;
    height.value = -1;
    return () => {
      if (back.current) clearTimeout(back.current);
    };
  }, [itemKey, x, armed, height]);

  const restore = () => {
    height.value = -1;
    armed.value = 0;
    x.value = withSpring(0, SETTLE);
  };
  const commit = (direction: number) => {
    const action = direction > 0 ? right : left;
    if (!action) return restore();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (action.removes === false) {
      action.run();
      restore();
      return;
    }
    height.value = measured.value;
    height.value = withTiming(0, { duration: COLLAPSE_MS }, (finished) => {
      if (finished) scheduleOnRN(action.run);
    });
    back.current = setTimeout(restore, COLLAPSE_MS + RETURN_MS);
  };

  const pan = usePanGesture({
    enabled: !!right || !!left,
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    onUpdate: (e) => {
      "worklet";
      const allowed = e.translationX > 0 ? canRight.value : canLeft.value;
      x.value = allowed ? e.translationX : e.translationX * RESIST;
      const reach = allowed ? Math.abs(e.translationX) / FULL_DRAG : 0;
      const next = reach >= COMMIT ? Math.sign(e.translationX) : 0;
      if (next === armed.value) return;
      armed.value = next;
      scheduleOnRN(tick);
    },
    onDeactivate: (e) => {
      "worklet";
      const direction = Math.sign(e.translationX);
      const allowed = direction > 0 ? canRight.value : canLeft.value;
      const flung =
        allowed && Math.sign(e.velocityX) === direction && Math.abs(e.velocityX) > FLING;
      if (armed.value === 0 && !flung) {
        x.value = withSpring(0, SETTLE);
        return;
      }
      armed.value = direction;
      x.value = withTiming(direction * width, { duration: LEAVE_MS }, (finished) => {
        if (finished) scheduleOnRN(commit, direction);
      });
    },
  });

  const box = useAnimatedStyle(() => (height.value < 0 ? {} : { height: height.value }));
  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  if (!right && !left) return style ? <View style={style}>{children}</View> : children;
  return (
    <Animated.View
      style={[styles.box, style, box]}
      onLayout={(e) => {
        if (height.value < 0) measured.value = e.nativeEvent.layout.height;
      }}
    >
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.row, row]}>
          {children}
          {right ? <Wash sign={1} action={right} x={x} armed={armed} /> : null}
          {left ? <Wash sign={-1} action={left} x={x} armed={armed} /> : null}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

function Wash({
  sign,
  action,
  x,
  armed,
}: {
  sign: 1 | -1;
  action: SwipeAction;
  x: SharedValue<number>;
  armed: SharedValue<number>;
}) {
  const fill = colors[FILL[action.tone]];
  const Icon = action.icon;
  const reach = (value: number) => {
    "worklet";
    return Math.min(1, Math.max(0, (sign * value) / FULL_DRAG));
  };
  const wash = useAnimatedStyle(() => ({ opacity: Math.min(1, reach(x.value) / COMMIT) }));
  const mark = useAnimatedStyle(() => {
    const p = reach(x.value);
    return {
      opacity: interpolate(p, [0, 0.15], [0, 1], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(p, [0, COMMIT], [0.85, 1], Extrapolation.CLAMP) }],
    };
  });
  const filled = useAnimatedStyle(() => ({
    opacity: withTiming(armed.value === sign ? 1 : 0, { duration: 120 }),
  }));
  return (
    <>
      <Animated.View pointerEvents="none" style={[styles.wash, { backgroundColor: fill }, wash]} />
      <Animated.View pointerEvents="none" style={[styles.mark, mark]}>
        <View style={styles.badge}>
          <Icon size={iconSize.md} color={colors.swipeForeground} />
          <Animated.View style={[styles.filled, filled]}>
            <Icon size={iconSize.md} color={fill} />
          </Animated.View>
        </View>
        <Text size="md" weight="semibold" tone="swipeForeground">
          {action.label}
        </Text>
      </Animated.View>
    </>
  );
}

const BADGE = space(9);

const styles = StyleSheet.create({
  box: { overflow: "hidden" },
  row: { backgroundColor: colors.background },
  wash: { ...StyleSheet.absoluteFill },
  mark: {
    ...StyleSheet.absoluteFill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space(2.5),
  },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: colors.swipeForeground,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  filled: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.swipeForeground,
    alignItems: "center",
    justifyContent: "center",
  },
});
