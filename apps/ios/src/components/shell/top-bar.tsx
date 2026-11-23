import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { IconMenu } from "@/components/icons.ts";
import { FloatingButton } from "@/components/ui/floating.tsx";
import { Text } from "@/components/ui/text.tsx";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { SHELL_CONTROL, useMenuPlace } from "./menu-nav.ts";
import { usePageTitle } from "./use-page-title.ts";

const SIDE = space(4);
const FADE_TAIL = space(6);

/**
 * The shell's top bar on a module's root page: ☰ on the left (opens the left sidebar drawer) and
 * the page's title and count centred. Transparent with a soft canvas fade behind it so scrolled
 * content slides under and dissolves.
 */
export function TopBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const insets = useSafeAreaInsets();
  const page = usePageTitle();
  const { setScrolled } = shell;
  useEffect(() => setScrolled(false), [page.title, place.mailbox, setScrolled]);

  if (shell.searching) return null;
  const barHeight = insets.top + space(2) + SHELL_CONTROL + space(2.5);
  return (
    <View style={[styles.bar, { paddingTop: insets.top + space(2) }]} pointerEvents="box-none">
      <View pointerEvents="none" style={[styles.fade, { height: barHeight + FADE_TAIL }]}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="top-fade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.background} stopOpacity={1} />
              <Stop offset="0.62" stopColor={colors.background} stopOpacity={0.92} />
              <Stop offset="1" stopColor={colors.background} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#top-fade)" />
        </Svg>
      </View>
      <View style={styles.leftSlot}>
        <FloatingButton
          icon={IconMenu}
          glyph={iconSize.md}
          label={shell.isOpen ? "Close menu" : "Open menu"}
          compact
          onPress={shell.toggle}
        />
      </View>
      <View style={styles.center} pointerEvents="none">
        <Text weight="semibold" numberOfLines={1} accessibilityRole="header" style={styles.title}>
          {page.title}
        </Text>
        {page.count ? (
          <Text size="subhead" tone="mutedForeground" tabular>
            {page.count}
          </Text>
        ) : null}
      </View>
      <View style={styles.rightSlot} />
    </View>
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
    paddingHorizontal: SIDE,
    paddingBottom: space(2.5),
  },
  fade: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  leftSlot: { flex: 1, height: SHELL_CONTROL, alignItems: "flex-start", justifyContent: "center" },
  rightSlot: { flex: 1, height: SHELL_CONTROL, alignItems: "flex-end", justifyContent: "center" },
  center: {
    flexShrink: 1,
    height: SHELL_CONTROL,
    marginHorizontal: space(2),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space(1.5),
  },
  title: { flexShrink: 1 },
});
