import { useLocalSearchParams } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { ScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { useReduceMotion } from "@/components/ui/use-reduce-motion.ts";
import { colors, radius, space } from "@/theme/tokens.ts";
import { FLOATING_BAR_SPACE } from "./floating-bar.tsx";
import { useMenu } from "./menu-context.tsx";
import { MenuDrawer } from "./menu-layer.tsx";
import { RootPlace, useShellTop, type Module } from "./menu-nav.ts";
import { ShellChrome } from "./shell.tsx";

const DRAWER_MAX = 320;
const DRAWER_RATIO = 0.82;
const EDGE_WIDTH = 24;
const OPEN_MS = 280;
const CLOSE_MS = 240;
const FLING = 500;
const EASE = Easing.out(Easing.cubic);

/**
 * A module's root page inside the reveal drawer shell: the module's nav menu sits underneath on
 * the left and fades/scales up as the current page slides right out of the way. Supports tapping
 * the top-left menu button, swiping right from the left edge, or tapping/swiping left on the
 * exposed page to close.
 */
export function ModuleRoot({ module, children }: { module: Module; children: ReactNode }) {
  const params = useLocalSearchParams<{ page?: string; mailbox?: string }>();
  const shell = useMenu();
  const shellTop = useShellTop();
  const statusBar = useSafeAreaInsets().top;
  const { width } = useWindowDimensions();
  const still = useReduceMotion();
  const drawerWidth = Math.min(Math.round(width * DRAWER_RATIO), DRAWER_MAX);
  const progress = useSharedValue(shell.isOpen ? 1 : 0);
  const [mounted, setMounted] = useState(shell.isOpen);

  useEffect(() => {
    if (shell.isOpen) setMounted(true);
    const target = shell.isOpen ? 1 : 0;
    const duration = still ? 0 : shell.isOpen ? OPEN_MS : CLOSE_MS;
    progress.value = withTiming(target, { duration, easing: EASE }, (finished) => {
      if (finished && target === 0) scheduleOnRN(setMounted, false);
    });
  }, [shell.isOpen, still, progress]);

  const beginDrag = () => setMounted(true);
  const finishDrag = (open: boolean) => {
    if (open) shell.open();
    else shell.close();
  };

  const openSwipe = usePanGesture({
    enabled: !shell.isOpen && !shell.searching,
    activeOffsetX: 10,
    failOffsetY: [-10, 10],
    onActivate: () => {
      "worklet";
      scheduleOnRN(beginDrag);
    },
    onUpdate: (e) => {
      "worklet";
      progress.value = Math.max(0, Math.min(1, e.translationX / drawerWidth));
    },
    onDeactivate: (e) => {
      "worklet";
      const shouldOpen = progress.value > 0.35 || e.velocityX > FLING;
      const duration = still ? 0 : shouldOpen ? OPEN_MS : CLOSE_MS;
      progress.value = withTiming(shouldOpen ? 1 : 0, { duration, easing: EASE }, (finished) => {
        if (finished && !shouldOpen) scheduleOnRN(setMounted, false);
      });
      scheduleOnRN(finishDrag, shouldOpen);
    },
  });

  const closeSwipe = usePanGesture({
    enabled: shell.isOpen,
    activeOffsetX: -10,
    failOffsetY: [-10, 10],
    onUpdate: (e) => {
      "worklet";
      progress.value = Math.max(0, Math.min(1, 1 + e.translationX / drawerWidth));
    },
    onDeactivate: (e) => {
      "worklet";
      const shouldClose = progress.value < 0.7 || e.velocityX < -FLING;
      const duration = still ? 0 : shouldClose ? CLOSE_MS : OPEN_MS;
      progress.value = withTiming(shouldClose ? 0 : 1, { duration, easing: EASE }, (finished) => {
        if (finished && shouldClose) scheduleOnRN(setMounted, false);
      });
      scheduleOnRN(finishDrag, !shouldClose);
    },
  });

  const pageShell = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * drawerWidth }],
  }));

  const pageClip = useAnimatedStyle(() => ({
    borderRadius: interpolate(
      progress.value,
      [0, 0.15, 1],
      [0, radius.sheet, radius.sheet],
      Extrapolation.CLAMP,
    ),
    borderWidth: interpolate(progress.value, [0, 0.05, 1], [0, 1, 1], Extrapolation.CLAMP),
  }));

  return (
    <RootPlace value={{ module, params }}>
      <ScrollEdge.Provider
        value={(event) => shell.setScrolled(event.nativeEvent.contentOffset.y > 0)}
      >
        <View style={styles.root}>
          {mounted ? (
            <MenuDrawer
              module={module}
              width={drawerWidth}
              progress={progress}
              interactive={shell.isOpen}
            />
          ) : null}
          <Animated.View style={[styles.pageShell, pageShell]}>
            <Animated.View style={[styles.pageClip, pageClip]}>
              <View
                style={[
                  styles.page,
                  { paddingTop: shell.searching ? statusBar + space(4) : shellTop },
                ]}
              >
                {children}
              </View>
              <ShellChrome />
              {mounted ? (
                <GestureDetector gesture={closeSwipe}>
                  <View pointerEvents={shell.isOpen ? "auto" : "none"} style={styles.scrim}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Close menu"
                      onPress={shell.close}
                      style={styles.scrimHit}
                    />
                  </View>
                </GestureDetector>
              ) : null}
              {!shell.isOpen && !shell.searching ? (
                <GestureDetector gesture={openSwipe}>
                  <View style={[styles.edge, { top: shellTop, bottom: FLOATING_BAR_SPACE }]} />
                </GestureDetector>
              ) : null}
            </Animated.View>
          </Animated.View>
        </View>
      </ScrollEdge.Provider>
    </RootPlace>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.sidebar, overflow: "hidden" },
  pageShell: { flex: 1 },
  pageClip: {
    flex: 1,
    backgroundColor: colors.background,
    borderColor: colors.border,
    overflow: "hidden",
  },
  page: { flex: 1, backgroundColor: colors.background },
  scrim: { ...StyleSheet.absoluteFill },
  scrimHit: { flex: 1 },
  edge: {
    position: "absolute",
    left: 0,
    width: EDGE_WIDTH,
  },
});
