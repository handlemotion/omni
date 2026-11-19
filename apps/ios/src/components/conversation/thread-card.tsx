import * as Haptics from "expo-haptics";
import { usePreventZoomTransitionDismissal } from "expo-router";
import { createContext, use, useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions, type ScrollViewProps } from "react-native";
import {
  GestureDetector,
  ScrollView,
  useCompetingGestures,
  usePanGesture,
  type PanGesture,
} from "react-native-gesture-handler";
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

/** What letting go of a far enough sideways drag does to the conversation. */
export interface CardAction {
  label: string;
  icon: ComponentType<SvgProps & { size?: number }>;
  run: () => void;
}

export interface ThreadCardProps {
  /** The conversation on the card: a new one slides in from the side the last one left by. */
  cardKey: string;
  /** Dragging right (Done). */
  right?: CardAction | null;
  /** Dragging left (Later). */
  left?: CardAction | null;
  /** A drag down far or fast enough: back to the list. */
  onDismiss: () => void;
  children: ReactNode;
}

const FULL_DRAG = 200;
const COMMIT = 0.6;
const FLING = 800;
const DISMISS_DRAG = 120;
const RESIST = 0.15;
const tick = () => void Haptics.selectionAsync();
const SETTLE = { damping: 22, stiffness: 240 } as const;

const SIDES = {
  right: { tone: "success", tint: colors.success, from: 0.06, to: 0.36 },
  left: { tone: "later", tint: colors.foreground, from: 0.04, to: 0.22 },
} as const satisfies Record<string, { tone: ColorToken; tint: string; from: number; to: number }>;

type Side = keyof typeof SIDES;

const CardScroll = createContext<{ dismiss: PanGesture; atTop: SharedValue<boolean> } | null>(null);

/**
 * A conversation as one card. Dragged sideways from anywhere, the whole page follows the finger
 * and tints (green to the right for Done, grey to the left for Later) under a badge that fills
 * solid once letting go would commit; letting go there carries it off and runs the action, and
 * earlier springs it back. Only a drag down (from the top of its scroll) dismisses it: the
 * native back swipe and the zoom's own dismissal are off, so sideways never closes it.
 */
export function ThreadCard({ cardKey, right, left, onDismiss, children }: ThreadCardProps) {
  const { width, height } = useWindowDimensions();
  usePreventZoomTransitionDismissal();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const armed = useSharedValue(0);
  const atTop = useSharedValue(true);
  const canRight = useSharedValue(!!right);
  const canLeft = useSharedValue(!!left);
  const entering = useRef(0);
  useEffect(() => {
    canRight.value = !!right;
    canLeft.value = !!left;
  }, [right, left, canRight, canLeft]);
  useEffect(() => {
    atTop.value = true;
    armed.value = 0;
    if (!entering.current) return;
    x.value = -entering.current * width;
    x.value = withSpring(0, SETTLE);
    entering.current = 0;
  }, [cardKey, width, x, armed, atTop]);

  const commit = (direction: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    entering.current = direction;
    (direction > 0 ? right : left)?.run();
  };

  const sideways = usePanGesture({
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
      x.value = withTiming(direction * (width + space(10)), { duration: 200 }, (finished) => {
        if (finished) scheduleOnRN(commit, direction);
      });
    },
  });
  const dismiss = usePanGesture({
    enabled: atTop,
    activeOffsetY: 12,
    failOffsetY: -8,
    failOffsetX: [-12, 12],
    onUpdate: (e) => {
      "worklet";
      y.value = Math.max(0, e.translationY);
    },
    onDeactivate: (e) => {
      "worklet";
      if (e.translationY > DISMISS_DRAG || e.velocityY > FLING) scheduleOnRN(onDismiss);
      else y.value = withSpring(0, SETTLE);
    },
  });
  const gesture = useCompetingGestures(sideways, dismiss);

  const card = useAnimatedStyle(() => ({
    borderRadius: interpolate(
      Math.max(Math.abs(x.value), y.value),
      [0, 24],
      [0, radius.screen],
      Extrapolation.CLAMP,
    ),
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: interpolate(y.value, [0, height], [1, 0.8], Extrapolation.CLAMP) },
    ],
  }));

  return (
    <View style={styles.behind}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.card, card]}>
          <CardScroll value={{ dismiss, atTop }}>{children}</CardScroll>
          {right ? <Wash side="right" action={right} x={x} armed={armed} /> : null}
          {left ? <Wash side="left" action={left} x={x} armed={armed} /> : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/**
 * The card's scrolling body. A drag down dismisses the card only from the top of it; anywhere
 * further down it scrolls back up as usual.
 */
export function CardScrollView({ onScroll, ...props }: ScrollViewProps) {
  const card = use(CardScroll);
  return (
    <ScrollView
      {...props}
      requireToFail={card?.dismiss}
      scrollEventThrottle={16}
      onScroll={(e) => {
        if (card) card.atTop.value = e.nativeEvent.contentOffset.y <= 0;
        onScroll?.(e);
      }}
    />
  );
}

function Wash({
  side,
  action,
  x,
  armed,
}: {
  side: Side;
  action: CardAction;
  x: SharedValue<number>;
  armed: SharedValue<number>;
}) {
  const { tone, tint, from, to } = SIDES[side];
  const sign = side === "right" ? 1 : -1;
  const Icon = action.icon;
  const reach = (value: number) => {
    "worklet";
    return Math.min(1, Math.max(0, (sign * value) / FULL_DRAG));
  };
  const wash = useAnimatedStyle(() => {
    const p = reach(x.value);
    return { opacity: p > 0 ? from + (to - from) * p : 0 };
  });
  const badge = useAnimatedStyle(() => {
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
      <Animated.View pointerEvents="none" style={[styles.wash, { backgroundColor: tint }, wash]} />
      <Animated.View pointerEvents="none" style={[styles.mark, badge]}>
        <View style={[styles.badge, { borderColor: colors[tone] }]}>
          <Icon size={iconSize.lg} color={colors[tone]} />
          <Animated.View style={[styles.fill, { backgroundColor: colors[tone] }, filled]}>
            <Icon size={iconSize.lg} color={colors.primaryForeground} />
          </Animated.View>
        </View>
        <Text size="lg" weight="semibold" tone={tone}>
          {action.label}
        </Text>
      </Animated.View>
    </>
  );
}

const BADGE = space(16);

const styles = StyleSheet.create({
  behind: { flex: 1, backgroundColor: colors.accent },
  card: { flex: 1, overflow: "hidden", backgroundColor: colors.background },
  wash: { ...StyleSheet.absoluteFill },
  mark: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "39%",
    alignItems: "center",
    gap: space(3),
  },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: radius.full,
    borderWidth: 2,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  fill: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
