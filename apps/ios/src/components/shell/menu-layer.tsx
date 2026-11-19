import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  type ScrollViewInstance,
} from "react-native";
import { colors, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useShellTop } from "./menu-nav.ts";
import { MENU_INSET } from "./menu-row.tsx";
import { CrmMenu, DriveMenu, MailMenu } from "./menu-rows.tsx";
import { useModules } from "./modules.ts";

const SLIDE_MS = 250;
const ROWS = { mail: MailMenu, drive: DriveMenu, crm: CrmMenu } as const;

/**
 * The menu, sliding down from under the top bar over the module (no dimming): one page per
 * module side by side, each its pages; a swipe changes module, and the top bar's pill follows.
 */
export function MenuLayer() {
  const shell = useMenu();
  const top = useShellTop();
  const { width, height } = useWindowDimensions();
  const y = useRef(new Animated.Value(-height)).current;
  const [mounted, setMounted] = useState(false);
  const still = useReduceMotion();
  useEffect(() => {
    if (shell.isOpen) setMounted(true);
    const slide = Animated.timing(y, {
      toValue: shell.isOpen ? 0 : -height,
      duration: still ? 0 : SLIDE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    slide.start(({ finished }) => finished && !shell.isOpen && setMounted(false));
    return () => slide.stop();
  }, [shell.isOpen, height, still, y]);
  if (!shell.isOpen && !mounted) return null;
  return (
    <Animated.View
      accessibilityViewIsModal
      style={[styles.layer, { top, transform: [{ translateY: y }] }]}
    >
      <Pages width={width} height={height - top} />
    </Animated.View>
  );
}

function Pages({ width, height }: { width: number; height: number }) {
  const shell = useMenu();
  const modules = useModules();
  const at = Math.max(
    0,
    modules.findIndex((m) => m.id === shell.browsing),
  );
  const pager = useRef<ScrollViewInstance>(null);
  const showing = useRef(at);
  const heading = useRef<number | null>(null);
  useEffect(() => {
    if (showing.current === at) return;
    showing.current = at;
    heading.current = at;
    pager.current?.scrollTo({ x: at * width, animated: true });
  }, [at, width]);
  return (
    <ScrollView
      ref={pager}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      contentOffset={{ x: at * width, y: 0 }}
      onLayout={() => pager.current?.scrollTo({ x: showing.current * width, animated: false })}
      scrollEventThrottle={16}
      onScrollBeginDrag={() => {
        heading.current = null;
      }}
      onScroll={(event) => {
        const next = Math.round(event.nativeEvent.contentOffset.x / width);
        if (heading.current !== null) {
          if (next === heading.current) heading.current = null;
          return;
        }
        const module = modules[next];
        if (!module || next === showing.current) return;
        showing.current = next;
        shell.browse(module.id);
      }}
    >
      {modules.map(({ id }) => {
        const Rows = ROWS[id];
        return (
          <ScrollView key={id} style={{ width, height }} contentContainerStyle={styles.rows}>
            <Rows />
          </ScrollView>
        );
      })}
    </ScrollView>
  );
}

function useReduceMotion() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setStill);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => sub.remove();
  }, []);
  return still;
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.background },
  rows: { paddingHorizontal: MENU_INSET, paddingTop: space(2), paddingBottom: space(30) },
});
