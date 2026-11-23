import { BlurView } from "expo-blur";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useEffect, type ReactNode } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { BarFade } from "@/components/ui/edge-blur.tsx";
import { useReduceMotion } from "@/components/ui/use-reduce-motion.ts";
import { colors, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace, useShownModule } from "./menu-nav.ts";
import {
  ModuleSection,
  SECTION_EASE,
  SECTION_MS,
  useRailLayout,
  useSectionPull,
} from "./module-panel.tsx";
import { useModules } from "./modules.ts";
import { NAV_BAR, NavBar, RAIL_BLOCK } from "./nav-bar.tsx";

const TAIL = space(24);

/**
 * The signed-in app's frame: every page, root or pushed, on one white surface with the rail
 * (`NavBar`) floating over its foot. Pulling the rail up, or tapping its handle or module, raises
 * the rail and slides the page up just above it, until the card only peeks under the status bar, blurred and dimmed behind a
 * prompt; the module's pages show beneath the rail. Tapping or pulling the card or the rail down
 * slides it all back. Pages see the rail as part of the bottom safe area, so their own bottom bars
 * sit above it. Only the open search field takes the whole screen.
 */
export function ShellFrame({ children }: { children: ReactNode }) {
  const shell = useMenu();
  const { module: landed } = useMenuPlace();
  const module = useShownModule();
  const { pending, setPending } = shell;
  useEffect(() => {
    if (pending && pending === landed) setPending(null);
  }, [pending, landed, setPending]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { railBottom, lift, cardLift } = useRailLayout();
  const taken = railBottom + RAIL_BLOCK + space(2);
  const still = useReduceMotion();
  const progress = useSharedValue(shell.isOpen ? 1 : 0);
  const pull = useSectionPull(progress, lift);
  const pullCard = useSectionPull(progress, lift);
  const modules = useModules();
  const current = Math.max(
    0,
    modules.findIndex((entry) => entry.id === module),
  );
  const follow = useSharedValue(current);

  useEffect(() => {
    progress.value = withTiming(shell.isOpen ? 1 : 0, {
      duration: still ? 0 : SECTION_MS,
      easing: SECTION_EASE,
    });
  }, [shell.isOpen, still, progress]);

  useEffect(() => {
    follow.value = current;
  }, [current, follow]);

  const card = useAnimatedStyle(() => ({
    transform: [{ translateY: -cardLift * progress.value }],
  }));
  const rail = useAnimatedStyle(() => ({ transform: [{ translateY: -lift * progress.value }] }));
  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: (current - follow.value) * width }],
  }));
  const wash = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.2, 0.8], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.card, card]}>
        <SafeAreaInsetsContext.Provider
          value={shell.searching ? insets : { ...insets, bottom: taken }}
        >
          <Animated.View style={[StyleSheet.absoluteFill, slide]}>{children}</Animated.View>
        </SafeAreaInsetsContext.Provider>
        {shell.searching ? null : <BarFade middle={railBottom + NAV_BAR / 2} />}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, wash]}>
          <BlurView intensity={10} tint="light" style={StyleSheet.absoluteFill} />
          <View style={styles.wash} />
          <Svg pointerEvents="none" width="100%" height={TAIL} style={styles.tail}>
            <Defs>
              <LinearGradient id="pageTail" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.background} stopOpacity={0} />
                <Stop offset="0.6" stopColor={colors.background} stopOpacity={0.85} />
                <Stop offset="1" stopColor={colors.background} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#pageTail)" />
          </Svg>
        </Animated.View>
        {shell.isOpen ? (
          <GestureDetector gesture={pullCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hide pages"
              onPress={shell.close}
              style={StyleSheet.absoluteFill}
            />
          </GestureDetector>
        ) : null}
      </Animated.View>
      <ModuleSection module={module} progress={progress} follow={follow} />
      {shell.searching ? null : (
        <GestureDetector gesture={pull}>
          <Animated.View style={[styles.rail, { bottom: railBottom }, rail]}>
            <NavBar progress={progress} />
          </Animated.View>
        </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, overflow: "hidden" },
  card: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
    backgroundColor: colors.background,
  },
  rail: { position: "absolute", left: 0, right: 0 },
  tail: { position: "absolute", left: 0, right: 0, bottom: 0 },
  wash: { ...StyleSheet.absoluteFill, backgroundColor: colors.background, opacity: 0.35 },
});
