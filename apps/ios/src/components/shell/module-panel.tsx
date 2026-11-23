import { useEffect, useMemo, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedRef,
  useAnimatedScrollHandler,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { RowHighlight } from "@/components/ui/pressable-row.tsx";
import { colors, radius, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import type { Module } from "./menu-nav.ts";
import { MENU_INSET, MenuUnder } from "./menu-row.tsx";
import { CalendarMenu, CrmMenu, DriveMenu, MailMenu, MeetingsMenu } from "./menu-rows.tsx";
import { RootPlace, useMenuPlace } from "./menu-nav.ts";
import { useModules } from "./modules.ts";
import { WorkspaceButton } from "./menu-workspace.tsx";
import { DOCK_HEIGHT, ModuleDock } from "./module-dock.tsx";

const WORKSPACE_SIZE = space(7);
const HANDLE = space(4);
const EDGE_FADE = space(6);
const FLING = 600;

/** How much of the page card stays on screen under the status bar while the pages are up. */
export const CARD_PEEK = space(20);

/** How long the section takes to open and close, and its curve. */
export const SECTION_MS = 300;
export const SECTION_EASE = Easing.out(Easing.cubic);

const ROWS = {
  mail: MailMenu,
  drive: DriveMenu,
  crm: CrmMenu,
  calendar: CalendarMenu,
  meetings: MeetingsMenu,
} as const;

/** The closed section's height under the page: the handle and the dock, above the home indicator. */
export function useSectionHeight() {
  return HANDLE + DOCK_HEIGHT + Math.max(useSafeAreaInsets().bottom - space(3), space(2));
}

/** How far the page card and the dock slide up: until the card only peeks under the status bar. */
export function useSectionTravel() {
  const { height } = useWindowDimensions();
  const top = useSafeAreaInsets().top;
  return height - useSectionHeight() - top - CARD_PEEK;
}

/** A vertical drag that follows the finger and settles the section open or closed. */
export function useSectionPull(progress: SharedValue<number>, travel: number) {
  const shell = useMenu();
  const start = useSharedValue(0);
  const settle = (open: boolean) => (open ? shell.open() : shell.close());
  return usePanGesture({
    activeOffsetY: [-8, 8],
    onBegin: () => {
      "worklet";
      start.value = progress.value;
    },
    onUpdate: (e) => {
      "worklet";
      progress.value = Math.min(1, Math.max(0, start.value - e.translationY / travel));
    },
    onDeactivate: (e) => {
      "worklet";
      const open = e.velocityY < -FLING || (e.velocityY < FLING && progress.value > 0.5);
      progress.value = withTiming(open ? 1 : 0, { duration: SECTION_MS, easing: SECTION_EASE });
      scheduleOnRN(settle, open);
    },
  });
}

/**
 * The section under a module's root page, on the grey surface: a handle, the module dock with the workspace at its end, and
 * under them the module's pages. Pulling the dock up (or tapping the handle) slides the page card
 * and the dock up until the card only peeks under the status bar; pulling down, tapping the card,
 * or picking a page slides them back. The pages of every module sit side by side: swiping them
 * sideways moves the dock's pill along and opens the module they land on, each page already
 * marking where that module opens. They fade out under the dock as they scroll.
 */
export function ModuleSection({
  module,
  progress,
  follow,
}: {
  module: Module;
  progress: SharedValue<number>;
  /** Which module's pages are under the dock, fractional mid-swipe. */
  follow: SharedValue<number>;
}) {
  const shell = useMenu();
  const place = useMenuPlace();
  const modules = useModules();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const closed = useSectionHeight();
  const travel = useSectionTravel();
  const pull = useSectionPull(progress, travel);
  const below = closed - HANDLE - DOCK_HEIGHT;
  const current = Math.max(
    0,
    modules.findIndex((entry) => entry.id === module),
  );
  const swiped = useRef(false);
  const start = useMemo(() => ({ x: current * width, y: 0 }), [current, width]);
  const pager = useAnimatedRef<Animated.ScrollView>();
  useEffect(() => {
    pager.current?.scrollTo({ x: current * width, animated: false });
  }, [pager, current, width]);
  const onScroll = useAnimatedScrollHandler((e) => {
    follow.value = e.contentOffset.x / width;
  });
  const land = (x: number) => {
    if (!swiped.current) return;
    swiped.current = false;
    const entry = modules[Math.round(x / width)];
    if (entry && entry.id !== module) place.openModule(entry.id);
  };

  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: -travel * progress.value }] }));
  const reveal = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [0, 1], Extrapolation.CLAMP),
  }));

  if (shell.searching) return null;
  return (
    <Animated.View style={[styles.section, { top: height - closed }, lift]}>
      <GestureDetector gesture={pull}>
        <View style={{ height: closed }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={shell.isOpen ? "Hide pages" : "Show pages"}
            accessibilityState={{ expanded: shell.isOpen }}
            onPress={shell.toggle}
            style={styles.handle}
          >
            <View style={styles.grabber} />
          </Pressable>
          <View style={styles.dockRow}>
            <ModuleDock follow={follow} />
            <View style={styles.workspace}>
              <WorkspaceButton size={WORKSPACE_SIZE} />
            </View>
          </View>
        </View>
      </GestureDetector>
      <Animated.View
        pointerEvents={shell.isOpen ? "auto" : "none"}
        accessibilityElementsHidden={!shell.isOpen}
        style={[styles.pages, reveal]}
      >
        <Animated.ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          onScroll={onScroll}
          scrollEventThrottle={16}
          showsHorizontalScrollIndicator={false}
          contentOffset={start}
          onScrollBeginDrag={() => {
            swiped.current = true;
          }}
          onMomentumScrollEnd={(e) => land(e.nativeEvent.contentOffset.x)}
        >
          {modules.map((entry) => {
            const Rows = ROWS[entry.id];
            const page = (
              <ScrollView
                key={entry.id}
                showsVerticalScrollIndicator={false}
                style={{ width, height: travel + below }}
                contentContainerStyle={[styles.rows, { paddingBottom: insets.bottom + space(2) }]}
              >
                <MenuUnder value>
                  <RowHighlight value={colors.underFill}>
                    <Rows />
                  </RowHighlight>
                </MenuUnder>
              </ScrollView>
            );
            if (entry.id === module && place.onRoot) return page;
            return (
              <RootPlace
                key={entry.id}
                value={{ module: entry.id, params: shell.lastPlace[entry.id] ?? {}, away: true }}
              >
                {page}
              </RootPlace>
            );
          })}
        </Animated.ScrollView>
        <Svg pointerEvents="none" width="100%" height={EDGE_FADE} style={styles.fade}>
          <Defs>
            <LinearGradient id="underFade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.under} stopOpacity={1} />
              <Stop offset="1" stopColor={colors.under} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#underFade)" />
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: { position: "absolute", left: 0, right: 0 },
  dockRow: { justifyContent: "center" },
  workspace: {
    position: "absolute",
    right: space(4),
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  handle: { height: HANDLE, alignItems: "center", justifyContent: "center" },
  grabber: {
    width: space(7),
    height: space(0.75),
    borderRadius: radius.full,
    backgroundColor: colors.hairlineLine,
  },
  pages: { position: "absolute", top: HANDLE + DOCK_HEIGHT, left: 0, right: 0 },
  rows: { paddingHorizontal: MENU_INSET, paddingTop: EDGE_FADE },
  fade: { position: "absolute", top: 0, left: 0 },
});
