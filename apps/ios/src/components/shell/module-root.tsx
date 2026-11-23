import { BlurView } from "expo-blur";
import { useLocalSearchParams } from "expo-router";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconChevronDown } from "@/components/icons.ts";
import { EdgeBlur } from "@/components/ui/edge-blur.tsx";
import { ScrollEdge } from "@/components/ui/scroll-edge.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useReduceMotion } from "@/components/ui/use-reduce-motion.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { RootPlace, TopInset, useShellTop, type Module } from "./menu-nav.ts";
import {
  CARD_PEEK,
  ModuleSection,
  SECTION_EASE,
  SECTION_MS,
  useSectionHeight,
  useSectionPull,
  useSectionTravel,
} from "./module-panel.tsx";
import { ModuleMainAction } from "./module-action.tsx";
import { useModules } from "./modules.ts";
import { ShellChrome } from "./shell.tsx";

const CARD_RADIUS = space(11);
const BOTTOM_FADE = space(16);

/**
 * A module's root page as a white card with round bottom corners and a hairline edge on the grey
 * surface, its title
 * and actions on top. Under the card sits the module section: the module dock, and below it the
 * module's pages, which the card and dock slide up to show. While they are up, the card peeks
 * under the status bar, blurred and dimmed behind a prompt; tapping or pulling it down slides it back.
 * Swiping the pages sideways slides the page's contents inside the card with them.
 */
export function ModuleRoot({ module, children }: { module: Module; children: ReactNode }) {
  const params = useLocalSearchParams<{ page?: string; space?: string; mailbox?: string }>();
  const shell = useMenu();
  const shellTop = useShellTop();
  const statusBar = useSafeAreaInsets().top;
  const section = useSectionHeight();
  const travel = useSectionTravel();
  const still = useReduceMotion();
  const progress = useSharedValue(shell.isOpen ? 1 : 0);
  const pull = useSectionPull(progress, travel);

  const { remember } = shell;
  useEffect(() => {
    remember(module, { page: params.page, space: params.space, mailbox: params.mailbox });
  }, [remember, module, params.page, params.space, params.mailbox]);

  useEffect(() => {
    progress.value = withTiming(shell.isOpen ? 1 : 0, {
      duration: still ? 0 : SECTION_MS,
      easing: SECTION_EASE,
    });
  }, [shell.isOpen, still, progress]);

  const { width } = useWindowDimensions();
  const modules = useModules();
  const current = Math.max(
    0,
    modules.findIndex((entry) => entry.id === module),
  );
  const follow = useSharedValue(current);
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
    <RootPlace value={{ module, params }}>
      <ScrollEdge.Provider
        value={(event) => shell.setScrolled(event.nativeEvent.contentOffset.y > 0)}
      >
        <View style={styles.root}>
          <Animated.View
            style={[styles.card, shell.searching ? styles.full : { bottom: section }, card]}
          >
            <Animated.View style={[StyleSheet.absoluteFill, slide]}>
              <TopInset value={shell.searching ? statusBar + space(4) : shellTop}>
                {children}
              </TopInset>
              {shell.searching ? null : (
                <EdgeBlur edge="bottom" height={BOTTOM_FADE} intensity={6} smooth />
              )}
              <ShellChrome />
              {shell.searching || shell.isOpen ? null : (
                <View style={styles.main}>
                  <ModuleMainAction />
                </View>
              )}
            </Animated.View>
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
          </Animated.View>
          <ModuleSection module={module} progress={progress} follow={follow} />
        </View>
      </ScrollEdge.Provider>
    </RootPlace>
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
    borderColor: colors.underLine,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomLeftRadius: CARD_RADIUS,
    borderBottomRightRadius: CARD_RADIUS,
    borderCurve: "continuous",
  },
  full: {
    bottom: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderRightWidth: 0,
  },
  main: { position: "absolute", right: space(4), bottom: space(5) },
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
