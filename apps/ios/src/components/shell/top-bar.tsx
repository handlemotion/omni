import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconMenu } from "@/components/icons.ts";
import { FloatingButton } from "@/components/ui/floating.tsx";
import { Text } from "@/components/ui/text.tsx";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { SHELL_CONTROL, useMenuPlace } from "./menu-nav.ts";
import { WorkspaceButton } from "./menu-workspace.tsx";
import { usePageTitle } from "./use-page-title.ts";

const FADE_MS = 180;
const SIDE = space(4);

/**
 * The shell's top bar on a module's root page: ☰ (opens the left navigation drawer) and the
 * workspace button in equal round slots at the sides; between them, centred on the screen, the
 * page's title and count. Its hairline shows once rows have scrolled under it. Steps away while
 * the bottom bar's search field is open.
 */
export function TopBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const insets = useSafeAreaInsets();
  const page = usePageTitle();
  const edge = useCrossfade(shell.scrolled && !shell.isOpen);
  const { setScrolled } = shell;
  useEffect(() => setScrolled(false), [page.title, place.mailbox, setScrolled]);
  if (shell.searching) return null;
  return (
    <View style={[styles.bar, { paddingTop: insets.top + space(2) }]}>
      <Animated.View pointerEvents="none" style={[styles.edge, { opacity: edge }]} />
      <View style={styles.slot}>
        <FloatingButton
          icon={IconMenu}
          glyph={iconSize.md}
          label={shell.isOpen ? "Close menu" : "Open menu"}
          compact
          onPress={shell.toggle}
        />
      </View>
      <View style={styles.center}>
        <Text weight="semibold" numberOfLines={1} accessibilityRole="header" style={styles.title}>
          {page.title}
        </Text>
        {page.count ? (
          <Text size="subhead" tone="mutedForeground" tabular>
            {page.count}
          </Text>
        ) : null}
      </View>
      <View style={styles.slot}>
        <WorkspaceButton />
      </View>
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
    backgroundColor: colors.background,
  },
  edge: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  slot: { width: SHELL_CONTROL, height: SHELL_CONTROL },
  center: {
    flex: 1,
    height: SHELL_CONTROL,
    marginHorizontal: space(3),
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space(1.5),
  },
  title: { flexShrink: 1 },
});

function useCrossfade(on: boolean) {
  const value = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    const fade = Animated.timing(value, {
      toValue: on ? 1 : 0,
      duration: FADE_MS,
      useNativeDriver: true,
    });
    fade.start();
    return () => fade.stop();
  }, [on, value]);
  return value;
}
