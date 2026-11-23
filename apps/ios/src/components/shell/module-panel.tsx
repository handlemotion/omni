import { useEffect, useMemo, useRef } from "react";
import { ScrollView, StyleSheet, useWindowDimensions } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { usePanGesture } from "react-native-gesture-handler";
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
import { colors, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import type { Module } from "./menu-nav.ts";
import { MENU_INSET } from "./menu-row.tsx";
import { CalendarMenu, CrmMenu, DriveMenu, MailMenu, MeetingsMenu } from "./menu-rows.tsx";
import { RootPlace, useMenuPlace } from "./menu-nav.ts";
import { useModules } from "./modules.ts";
import { RAIL_BLOCK } from "./nav-bar.tsx";

const EDGE_FADE = space(4);
const FLING = 600;

/** How much of the page card stays on screen under the status bar while the pages are up. */
export const CARD_PEEK = space(14);

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

const RAIL_GAP = space(2);

/**
 * Where the rail floats and how far things slide: the rail and the pages under it rise by `lift`,
 * the page card by `cardLift`, so its content stops just above the rail, peeking under the status bar.
 */
export function useRailLayout() {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const railBottom = Math.max(insets.bottom - space(3), space(2));
  const lift = height - insets.top - CARD_PEEK - railBottom - RAIL_BLOCK - RAIL_GAP;
  return { railBottom, lift, cardLift: lift + railBottom + RAIL_GAP };
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
 * The module's pages under the rail, on the same white surface, hidden below the screen until the rail
 * and page slide up. The pages of every module sit side by side: swiping them sideways opens the
 * module they land on, each page already marking where that module opens.
 */
export function ModuleSection({
  module,
  progress,
  follow,
}: {
  module: Module;
  progress: SharedValue<number>;
  /** Which module's pages show, fractional mid-swipe. */
  follow: SharedValue<number>;
}) {
  const shell = useMenu();
  const place = useMenuPlace();
  const modules = useModules();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { lift: travel, railBottom } = useRailLayout();
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
    <Animated.View style={[styles.section, { top: height - railBottom }, lift]}>
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
                style={{ width, height: travel + railBottom }}
                contentContainerStyle={[styles.rows, { paddingBottom: insets.bottom + space(2) }]}
              >
                <Rows />
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
              <Stop offset="0" stopColor={colors.background} stopOpacity={1} />
              <Stop offset="1" stopColor={colors.background} stopOpacity={0} />
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
  pages: { position: "absolute", top: 0, left: 0, right: 0 },
  rows: { paddingHorizontal: MENU_INSET, paddingTop: space(3) },
  fade: { position: "absolute", top: 0, left: 0 },
});
