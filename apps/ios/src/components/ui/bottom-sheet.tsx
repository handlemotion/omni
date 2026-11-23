import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  useNativeGesture,
  usePanGesture,
} from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";
import { useReduceMotion } from "./use-reduce-motion.ts";

const INSET = space(3.5);
const SCREEN_CORNER = space(15);
const CORNER = SCREEN_CORNER - INSET;
const TOP_CORNER = space(7);
const MAX_SHARE = 0.8;
const OPEN_MS = 360;
const CLOSE_MS = 240;
const EASE = Easing.bezier(0.32, 0.72, 0, 1);
const DISMISS_SHARE = 0.3;
const FLING = 800;

/**
 * A sheet's (or a popover's) open state, and `pick(then)` for its rows: close it and run `then`
 * once it has gone (`onClosed`). Both are native modals: a row that navigates, closes the menu
 * holding the sheet, or presents another view controller (a picker, a prompt) while one is still
 * up or on its way out makes UIKit and the native stack disagree with React about what is on
 * screen, and the shell vanishes until something later sets it right.
 */
export function useSheet() {
  const [isOpen, setOpen] = useState(false);
  const after = useRef<(() => void) | null>(null);
  return {
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    pick: (then: () => void) => {
      after.current = then;
      setOpen(false);
    },
    onClosed: () => {
      const then = after.current;
      after.current = null;
      then?.();
    },
  };
}

/**
 * A white card floating inset from the screen's edges with round corners, over a dimmed page: a
 * grabber, its title, then its rows. Pulling it down anywhere closes it (from the rows too, once
 * they are scrolled to the top), as does a tap above it.
 */
export function BottomSheet({
  isOpen,
  onClose,
  onClosed,
  title,
  header,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Once the sheet has gone: where to open what a row picked, so it is not under the sheet. */
  onClosed?: () => void;
  title: string;
  /** Drawn in place of the title (a file's tile, name and size); `title` still names the sheet. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height: screen } = useWindowDimensions();
  const still = useReduceMotion();
  const [mounted, setMounted] = useState(isOpen);
  const [height, setHeight] = useState(0);
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const anchor = useSharedValue(0);
  if (isOpen && !mounted) setMounted(true);
  const measured = height > 0;
  const bottom = INSET;

  useEffect(() => {
    if (isOpen && !measured) return;
    if (!isOpen && !mounted) return;
    if (isOpen) drag.value = 0;
    shown.value = withTiming(
      isOpen ? 1 : 0,
      { duration: still ? 0 : isOpen ? OPEN_MS : CLOSE_MS, easing: EASE },
      (finished) => {
        if (finished && !isOpen) scheduleOnRN(setMounted, false);
      },
    );
  }, [isOpen, measured, mounted, still, shown, drag]);

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const native = useNativeGesture({});
  const pull = usePanGesture({
    activeOffsetY: [-8, 8],
    failOffsetX: [-16, 16],
    simultaneousWith: native,
    onBegin: () => {
      "worklet";
      anchor.value = 0;
    },
    onUpdate: (e) => {
      "worklet";
      if (scrollY.value > 0) {
        anchor.value = e.translationY;
        return;
      }
      drag.value = Math.max(0, e.translationY - anchor.value);
    },
    onDeactivate: (e) => {
      "worklet";
      if (drag.value > height * DISMISS_SHARE || (drag.value > 0 && e.velocityY > FLING)) {
        scheduleOnRN(onClose);
        return;
      }
      drag.value = withTiming(0, { duration: CLOSE_MS, easing: EASE });
    },
  });

  const off = (measured ? height : screen) + bottom;
  const card = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(shown.value, [0, 1], [off, 0]) + drag.value }],
  }));
  const scrim = useAnimatedStyle(() => ({
    opacity: shown.value * Math.max(0, 1 - drag.value / off),
  }));

  return (
    <Modal
      transparent
      visible={mounted}
      animationType="none"
      onRequestClose={onClose}
      onDismiss={onClosed}
    >
      <GestureHandlerRootView style={styles.fill}>
        <Animated.View style={[styles.scrim, scrim]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${title}`}
            onPress={onClose}
            style={styles.fill}
          />
        </Animated.View>
        <GestureDetector gesture={pull}>
          <Animated.View
            accessibilityViewIsModal
            onLayout={(event) => {
              const next = event.nativeEvent.layout.height;
              if (next !== height) setHeight(next);
            }}
            style={[styles.card, { bottom, maxHeight: screen * MAX_SHARE }, card]}
          >
            <View style={styles.grabber} />
            {header ?? (
              <View style={styles.title}>
                <Text weight="semibold" accessibilityRole="header" numberOfLines={1}>
                  {title}
                </Text>
              </View>
            )}
            <GestureDetector gesture={native}>
              <Animated.ScrollView
                bounces={false}
                onScroll={onScroll}
                scrollEventThrottle={16}
                contentContainerStyle={{
                  paddingBottom: Math.max(insets.bottom - INSET, 0) + space(2),
                }}
              >
                {children}
              </Animated.ScrollView>
            </GestureDetector>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  card: {
    position: "absolute",
    left: INSET,
    right: INSET,
    paddingTop: space(2),
    paddingHorizontal: space(1.5),
    borderTopLeftRadius: TOP_CORNER,
    borderTopRightRadius: TOP_CORNER,
    borderBottomLeftRadius: CORNER,
    borderBottomRightRadius: CORNER,
    borderCurve: "continuous",
    backgroundColor: colors.background,
  },
  grabber: {
    alignSelf: "center",
    width: space(9),
    height: space(1.25),
    marginBottom: space(2),
    borderRadius: radius.full,
    backgroundColor: colors.hairlineLine,
  },
  title: { height: space(11), justifyContent: "center", paddingHorizontal: space(3.5) },
});
