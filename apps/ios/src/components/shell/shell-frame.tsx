import { BlurView } from "expo-blur";
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
import { IconChevronDown } from "@/components/icons.ts";
import { BarFade } from "@/components/ui/edge-blur.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useReduceMotion } from "@/components/ui/use-reduce-motion.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import {
  CARD_PEEK,
  ModuleSection,
  SECTION_EASE,
  SECTION_MS,
  useSectionHeight,
  useSectionPull,
  useSectionTravel,
} from "./module-panel.tsx";
import { useModules } from "./modules.ts";
import { NAV_BAR, NAV_CHEVRON, NavBar } from "./nav-bar.tsx";

const CARD_RADIUS = space(11);

/**
 * The signed-in app's frame: every page, root or pushed, sits in a white card with round bottom
 * corners, outlined on top of whatever the page draws, with the floating navigation (`NavBar`) at
 * its foot. The module section (the module dock and every page of the module) waits below the
 * screen: the bar's chevron or module button slides the card up to show it, until the card only
 * peeks under the status bar, blurred and dimmed behind a prompt; tapping or pulling it down
 * slides it back. Pages see the bar as part of the bottom safe area, so their own bottom bars sit
 * above it. Only the open search field takes the whole screen.
 */
export function ShellFrame({ children }: { children: ReactNode }) {
  const shell = useMenu();
  const { module } = useMenuPlace();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const section = useSectionHeight();
  const barBottom = Math.max(insets.bottom - space(3), space(2));
  const taken = barBottom + NAV_CHEVRON + NAV_BAR + space(2);
  const travel = useSectionTravel();
  const still = useReduceMotion();
  const progress = useSharedValue(shell.isOpen ? 1 : 0);
  const pull = useSectionPull(progress, travel);
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

  const card = useAnimatedStyle(() => ({ transform: [{ translateY: -travel * progress.value }] }));
  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: (current - follow.value) * width }],
  }));
  const wash = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.2, 0.8], [0, 1], Extrapolation.CLAMP),
  }));
  const hint = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.6, 1], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <View style={styles.root}>
      <Animated.View
        style={[styles.card, shell.searching ? styles.full : { bottom: section }, card]}
      >
        <SafeAreaInsetsContext.Provider
          value={shell.searching ? insets : { ...insets, bottom: taken }}
        >
          <Animated.View style={[StyleSheet.absoluteFill, slide]}>{children}</Animated.View>
        </SafeAreaInsetsContext.Provider>
        {shell.searching ? null : (
          <>
            <BarFade middle={barBottom + NAV_CHEVRON + NAV_BAR} />
            <NavBar bottom={barBottom} />
          </>
        )}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, wash]}>
          <BlurView intensity={10} tint="light" style={StyleSheet.absoluteFill} />
          <View style={styles.wash} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.hint, hint]}>
          <IconChevronDown size={iconSize.sm} color={colors.mutedForeground} />
          <Text size="sm" tone="mutedForeground">
            Swipe down to hide
          </Text>
        </Animated.View>
        {shell.isOpen ? (
          <GestureDetector gesture={pull}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hide pages"
              onPress={shell.close}
              style={StyleSheet.absoluteFill}
            />
          </GestureDetector>
        ) : null}
        {shell.searching ? null : <View pointerEvents="none" style={styles.outline} />}
      </Animated.View>
      <ModuleSection module={module} progress={progress} follow={follow} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.under, overflow: "hidden" },
  card: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
    backgroundColor: colors.background,
    borderBottomLeftRadius: CARD_RADIUS,
    borderBottomRightRadius: CARD_RADIUS,
    borderCurve: "continuous",
  },
  full: { bottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  outline: {
    ...StyleSheet.absoluteFill,
    borderColor: colors.underLine,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomLeftRadius: CARD_RADIUS,
    borderBottomRightRadius: CARD_RADIUS,
    borderCurve: "continuous",
  },
  wash: { ...StyleSheet.absoluteFill, backgroundColor: colors.background, opacity: 0.35 },
  hint: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: CARD_PEEK,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space(1.5),
  },
});
