import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconMenu, IconX } from "@/components/icons.ts";
import { FloatingButton } from "@/components/ui/floating.tsx";
import { PagePill } from "@/components/ui/page-pill.tsx";
import { Text } from "@/components/ui/text.tsx";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { SHELL_CONTROL, useCloseMenu, useMenuPlace, useShellTop } from "./menu-nav.ts";
import { WorkspaceButton } from "./menu-workspace.tsx";
import { useModules } from "./modules.ts";
import { usePageTitle } from "./use-page-title.ts";

const FADE_MS = 180;

const SIDE = space(4);

/**
 * The shell's one top bar, the same over a module and over the menu: ☰ (✕ while the menu is
 * open) and the workspace in equal round slots at the sides; between them, centred on the
 * screen, the page's title and count, crossfading to the module pill while the menu is open (a
 * chevron or a swipe there changes module). Its hairline shows only once the page's rows
 * have scrolled under it. It steps away while the bottom bar's search field is open.
 */
export function TopBar() {
  const shell = useMenu();
  const place = useMenuPlace();
  const closeMenu = useCloseMenu();
  const insets = useSafeAreaInsets();
  const top = useShellTop();
  const modules = useModules();
  const shown = shell.isOpen ? shell.browsing : place.module;
  const index = Math.max(
    0,
    modules.findIndex((m) => m.id === shown),
  );
  const current = modules[index] ?? modules[0];
  const page = usePageTitle();
  const menu = useCrossfade(shell.isOpen);
  const edge = useCrossfade(shell.scrolled && !shell.isOpen);
  const { setScrolled } = shell;
  useEffect(() => setScrolled(false), [page.title, place.mailbox, setScrolled]);
  if (!current || shell.searching) return null;
  return (
    <View style={[styles.bar, { paddingTop: insets.top + space(2) }]}>
      <Animated.View pointerEvents="none" style={[styles.edge, { opacity: edge }]} />
      <View style={styles.slot}>
        <FloatingButton
          icon={shell.isOpen ? IconX : IconMenu}
          glyph={shell.isOpen ? iconSize.field : iconSize.md}
          label={shell.isOpen ? "Close menu" : "Open menu"}
          compact
          onPress={() => (shell.isOpen ? closeMenu() : shell.open(place.module))}
        />
      </View>
      <View style={styles.center}>
        <Animated.View
          pointerEvents={shell.isOpen ? "none" : "auto"}
          style={[
            styles.layer,
            { opacity: menu.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
          ]}
        >
          <Text weight="semibold" numberOfLines={1} accessibilityRole="header" style={styles.title}>
            {page.title}
          </Text>
          {page.count ? (
            <Text size="subhead" tone="mutedForeground" tabular>
              {page.count}
            </Text>
          ) : null}
        </Animated.View>
        <Animated.View
          pointerEvents={shell.isOpen ? "auto" : "none"}
          style={[styles.layer, { opacity: menu }]}
        >
          <PagePill
            icon={current.icon}
            tile={current.color}
            label={current.label}
            count={modules.length}
            index={index}
            labels={modules.map((m) => m.label)}
            onPick={(at) => {
              const next = modules[at];
              if (!next) return;
              if (shell.isOpen) shell.browse(next.id);
              else place.openModule(next.id);
            }}
          />
        </Animated.View>
      </View>
      <View style={styles.slot}>
        <WorkspaceButton top={top + space(2)} right={SIDE} />
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
  center: { flex: 1, height: SHELL_CONTROL, marginHorizontal: space(3) },
  layer: {
    ...StyleSheet.absoluteFill,
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
