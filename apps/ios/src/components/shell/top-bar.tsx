import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TitleFade } from "@/components/ui/edge-blur.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useReduceMotion } from "@/components/ui/use-reduce-motion.ts";
import { space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { SHELL_CONTROL } from "./menu-nav.ts";
import { WorkspaceButton } from "./menu-workspace.tsx";
import { ModuleSearch } from "./module-action.tsx";
import { usePageTitle } from "./page-title.ts";

const SIDE = space(4);
const AVATAR = space(8);
const FADE_RAMP = SHELL_CONTROL + space(6);
const FADE_MS = 200;

/**
 * The shell's top bar on a module's root page: the page's title, small, and the module's search and the workspace opposite it. Once the page scrolls, it is covered behind the status bar and eases out through the title
 * and eases out through the title, so rows soften as they pass under it.
 */
export function TopBar() {
  const shell = useMenu();
  const insets = useSafeAreaInsets();
  const title = usePageTitle();
  const still = useReduceMotion();
  const shown = useSharedValue(shell.scrolled ? 1 : 0);
  useEffect(() => {
    shown.value = withTiming(shell.scrolled ? 1 : 0, { duration: still ? 0 : FADE_MS });
  }, [shell.scrolled, still, shown]);
  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));
  if (shell.searching) return null;
  const top = insets.top + space(2);
  return (
    <>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, fade]}>
        <TitleFade covered={top} ramp={FADE_RAMP} />
      </Animated.View>
      <View style={[styles.bar, { paddingTop: top }]} pointerEvents="box-none">
        <Text
          size="lg"
          weight="medium"
          numberOfLines={1}
          accessibilityRole="header"
          style={styles.title}
        >
          {title}
        </Text>
        <View style={styles.end} pointerEvents="box-none">
          <ModuleSearch />
          <WorkspaceButton size={AVATAR} />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space(3),
    paddingHorizontal: SIDE,
    minHeight: SHELL_CONTROL,
  },
  end: { flexDirection: "row", alignItems: "center", gap: space(1) },
  title: { flexShrink: 1, paddingLeft: space(1) },
});
