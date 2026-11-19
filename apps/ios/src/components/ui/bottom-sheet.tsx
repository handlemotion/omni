import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";
import { useReduceMotion } from "./use-reduce-motion.ts";

const OPEN_MS = 360;
const CLOSE_MS = 240;
const SHEET_EASE = Easing.bezier(0.32, 0.72, 0, 1);
const DISMISS_SHARE = 0.3;
const DISMISS_SPEED = 0.8;

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
 * A sheet that slides up from the bottom edge while the page behind it dims: a grabber, its
 * title, then its rows. A tap above it, or a drag down on its grabber and title, closes it.
 */
export function BottomSheet({
  isOpen,
  onClose,
  onClosed,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Once the sheet has gone: where to open what a row picked, so it is not under the sheet. */
  onClosed?: () => void;
  title: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const motion = useSheetMotion(isOpen, onClose);
  return (
    <Modal
      transparent
      visible={motion.mounted}
      animationType="none"
      onRequestClose={onClose}
      onDismiss={onClosed}
    >
      <Animated.View pointerEvents="box-none" style={[styles.fill, { opacity: motion.shown }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
          onPress={onClose}
          style={styles.scrim}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        onLayout={(event) => motion.measure(event.nativeEvent.layout.height)}
        style={[
          styles.sheet,
          {
            paddingBottom: Math.max(insets.bottom, space(10)),
            transform: [{ translateY: motion.y }],
          },
        ]}
      >
        <View {...motion.handle}>
          <View style={styles.grabber} />
          <View style={styles.title}>
            <Text weight="semibold" accessibilityRole="header">
              {title}
            </Text>
          </View>
        </View>
        <ScrollView>{children}</ScrollView>
      </Animated.View>
    </Modal>
  );
}

function useSheetMotion(isOpen: boolean, onClose: () => void) {
  const still = useReduceMotion();
  const { height: screen } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(isOpen);
  const [height, setHeight] = useState(0);
  const latest = useRef({ height, onClose });
  latest.current = { height, onClose };

  if (isOpen && !mounted) setMounted(true);
  const measured = height > 0;
  useEffect(() => {
    if (isOpen && !measured) return;
    if (!isOpen && !mounted) return;
    const run = Animated.timing(progress, {
      toValue: isOpen ? 1 : 0,
      duration: still ? 0 : isOpen ? OPEN_MS : CLOSE_MS,
      easing: SHEET_EASE,
      useNativeDriver: true,
    });
    if (isOpen) drag.setValue(0);
    run.start(({ finished }) => {
      if (!finished || isOpen) return;
      drag.setValue(0);
      setMounted(false);
    });
    return () => run.stop();
  }, [isOpen, measured, mounted, still, progress, drag]);

  const handle = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_, g) => {
          const far = g.dy > latest.current.height * DISMISS_SHARE;
          if (far || g.vy > DISMISS_SPEED) {
            latest.current.onClose();
            return;
          }
          Animated.spring(drag, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () =>
          Animated.spring(drag, { toValue: 0, bounciness: 0, useNativeDriver: true }).start(),
      }).panHandlers,
    [drag],
  );

  const off = measured ? height : screen;
  const { y, shown } = useMemo(
    () => ({
      y: Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [off, 0] }), drag),
      shown: Animated.multiply(
        progress,
        drag.interpolate({ inputRange: [0, off], outputRange: [1, 0], extrapolate: "clamp" }),
      ),
    }),
    [off, progress, drag],
  );
  return {
    mounted,
    shown,
    y,
    measure: (next: number) => next !== height && setHeight(next),
    handle,
  };
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "80%",
    paddingTop: space(2),
    paddingHorizontal: space(1.5),
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    backgroundColor: colors.background,
  },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
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
