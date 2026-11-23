import type { ComponentType } from "react";
import { useEffect } from "react";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import {
  GestureDetector,
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import type { SvgProps } from "react-native-svg";
import {
  IconBubble,
  IconBuildings,
  IconChecklist,
  IconClock,
  IconClock3,
  IconHandshake,
  IconInbox,
  IconMail,
  IconTrash,
  IconUserRound,
  IconUsers,
} from "@/components/icons.ts";
import { MAIL_PAGES, type MailPage } from "@/lib/mail.ts";
import { CRM_PAGES, type CrmPage } from "@/lib/crm.ts";
import { DRIVE_PAGES, type DrivePage } from "@/lib/drive.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { ModuleMainAction } from "./module-action.tsx";
import { useModules } from "./modules.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;
interface Shortcut {
  id: string;
  icon: Glyph;
  label: string;
}

/** The bar's height, and how far above the home indicator it floats. */
export const NAV_BAR = space(12);
const NAV_HANDLE = space(5);
const SIDE = space(11);
const GAP = space(3);
const EDGE = space(6.5);
const SWIPE = 30;
const SPRING = { damping: 18, stiffness: 260, mass: 0.6 };
/** The rail's whole height: its handle and its row. */
export const RAIL_BLOCK = NAV_HANDLE + NAV_BAR;

const MAIL: { id: MailPage; icon: Glyph }[] = [
  { id: "inbox", icon: IconInbox },
  { id: "needsReply", icon: IconBubble },
  { id: "later", icon: IconClock },
  { id: "all", icon: IconMail },
];
const CRM: { id: CrmPage; icon: Glyph }[] = [
  { id: "companies", icon: IconBuildings },
  { id: "people", icon: IconUsers },
  { id: "deals", icon: IconHandshake },
  { id: "tasks", icon: IconChecklist },
];

function useShortcuts() {
  const place = useMenuPlace();
  const company = hasCrm(useWorkspace().active);
  if (place.module === "mail") {
    return {
      current: place.mailPage,
      items: MAIL.map((p) => ({ ...p, label: MAIL_PAGES[p.id].label })),
      open: (id: string) => place.openMail({ page: id as MailPage }),
    };
  }
  if (place.module === "crm") {
    return {
      current: place.crmPage,
      items: CRM.map((p) => ({ ...p, label: CRM_PAGES[p.id].label })),
      open: (id: string) => place.openPage("crm", id),
    };
  }
  if (place.module === "drive") {
    const drive: { id: DrivePage; icon: Glyph }[] = [
      { id: "recents", icon: IconClock3 },
      { id: "my", icon: IconUserRound },
      ...(company ? [{ id: "shared" as const, icon: IconUsers }] : []),
      { id: "trash", icon: IconTrash },
    ];
    return {
      current: place.drivePage,
      items: drive.map((p) => ({ ...p, label: DRIVE_PAGES[p.id].label })),
      open: (id: string) => place.openPage("drive", id),
    };
  }
  return { current: undefined, items: [] as Shortcut[], open: () => {} };
}

/**
 * The rail, on every page: a handle on top; the current module in a round button on the left
 * (swipe it sideways for the next or previous module; once grown, drag across it to pick one); the module's main pages as glyphs in the
 * middle; the module's main action (compose, new file, new record) on the right. While the rail
 * is up (`progress` → 1) the module button grows into a pill of every module across the width,
 * and the pages and the main action fold away. Pulling the rail (it sits in the frame's pull) or
 * tapping the handle or the module raises it.
 */
export function NavBar({ progress }: { progress: SharedValue<number> }) {
  const shell = useMenu();
  const place = useMenuPlace();
  const modules = useModules();
  const { width } = useWindowDimensions();
  const shortcuts = useShortcuts();
  const current = Math.max(
    0,
    modules.findIndex((m) => m.id === place.module),
  );
  const full = width - EDGE * 2;
  const slot = full / Math.max(modules.length, 1);
  const pagesWidth = full - (SIDE + GAP) * 2;

  const step = (by: number) => {
    const next = modules[current + by];
    if (next) place.openModule(next.id);
  };
  const open = useSharedValue(shell.isOpen);
  const lens = useSharedValue(current * slot);
  useEffect(() => {
    open.value = shell.isOpen;
    lens.value = withSpring(current * slot, SPRING);
  }, [shell.isOpen, current, slot, open, lens]);
  const pick = (index: number) => {
    const next = modules[index];
    if (next && index !== current) place.openModule(next.id);
  };
  const under = (x: number) => {
    "worklet";
    return Math.min(Math.max(x - slot / 2, 0), (modules.length - 1) * slot);
  };
  const swipe = usePanGesture({
    activeOffsetX: [-12, 12],
    failOffsetY: [-12, 12],
    onUpdate: (e) => {
      "worklet";
      if (open.value) lens.value = under(e.x);
    },
    onDeactivate: (e) => {
      "worklet";
      if (open.value) {
        const index = Math.round(lens.value / slot);
        lens.value = withSpring(index * slot, SPRING);
        scheduleOnRN(pick, index);
        return;
      }
      if (Math.abs(e.translationX) < SWIPE) return;
      scheduleOnRN(step, e.translationX < 0 ? 1 : -1);
    },
  });
  const lensStyle = useAnimatedStyle(() => ({ transform: [{ translateX: lens.value }] }));

  const moduleWrap = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [SIDE, full], Extrapolation.CLAMP),
  }));
  const moduleRow = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [(SIDE - slot) / 2 - current * slot, 0],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
  const highlight = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.4, 1], [0, 1], Extrapolation.CLAMP),
  }));
  const fold = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
  }));
  const pages = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [pagesWidth, 0], Extrapolation.CLAMP),
    marginLeft: interpolate(progress.value, [0, 1], [GAP, 0], Extrapolation.CLAMP),
  }));
  const action = useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [SIDE, 0], Extrapolation.CLAMP),
    marginLeft: interpolate(progress.value, [0, 1], [GAP, 0], Extrapolation.CLAMP),
  }));

  return (
    <View pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={shell.isOpen ? "Hide pages" : "All pages and modules"}
        accessibilityState={{ expanded: shell.isOpen }}
        hitSlop={space(2)}
        onPress={shell.toggle}
        style={styles.handle}
      >
        <View style={styles.grabber} />
      </Pressable>
      <View pointerEvents="box-none" style={styles.row}>
        <GestureDetector gesture={swipe}>
          <Animated.View accessibilityRole="tablist" style={[styles.modules, moduleWrap]}>
            <Animated.View style={[styles.moduleRow, { width: full }, moduleRow]}>
              <Animated.View
                pointerEvents="none"
                style={[styles.lens, { width: slot }, lensStyle, highlight]}
              >
                <View style={[styles.here, styles.moduleHere]} />
              </Animated.View>
              {modules.map((m, index) => {
                const Mark = m.mark;
                const here = index === current;
                return (
                  <Pressable
                    key={m.id}
                    accessibilityRole="tab"
                    accessibilityLabel={m.label}
                    accessibilityState={{ selected: here }}
                    onPress={() => (shell.isOpen ? place.openModule(m.id) : shell.toggle())}
                    style={[styles.module, { width: slot }]}
                  >
                    <Mark size={22} />
                  </Pressable>
                );
              })}
            </Animated.View>
          </Animated.View>
        </GestureDetector>
        <Animated.View
          pointerEvents={shell.isOpen ? "none" : "auto"}
          style={[styles.foldWrap, pages, fold]}
        >
          {shortcuts.items.length ? (
            <PagePill
              width={pagesWidth}
              items={shortcuts.items}
              current={place.onRoot ? shortcuts.current : undefined}
              onOpen={shortcuts.open}
            />
          ) : null}
        </Animated.View>
        <Animated.View
          pointerEvents={shell.isOpen ? "none" : "auto"}
          style={[styles.foldWrap, styles.actionWrap, action, fold]}
        >
          <ModuleMainAction />
        </Animated.View>
      </View>
    </View>
  );
}

const PILL_INSET = space(1) + 1;

function PagePill(props: {
  width: number;
  items: Shortcut[];
  current: string | undefined;
  onOpen: (id: string) => void;
}) {
  const { items, onOpen } = props;
  const slot = (props.width - PILL_INSET * 2) / items.length;
  const index = items.findIndex((item) => item.id === props.current);
  const x = useSharedValue(Math.max(index, 0) * slot);
  const shown = useSharedValue(index < 0 ? 0 : 1);
  useEffect(() => {
    if (index < 0) {
      shown.value = withTiming(0);
      return;
    }
    shown.value = withTiming(1);
    x.value = withSpring(index * slot, SPRING);
  }, [index, slot, x, shown]);
  const open = (at: number) => {
    const item = items[at];
    if (item) onOpen(item.id);
  };
  const under = (touchX: number) => {
    "worklet";
    return Math.min(Math.max(Math.floor((touchX - PILL_INSET) / slot), 0), items.length - 1);
  };
  const tap = useTapGesture({
    maxDistance: 10,
    onActivate: (e) => {
      "worklet";
      const at = under(e.x);
      shown.value = withTiming(1);
      x.value = withSpring(at * slot, SPRING);
      scheduleOnRN(open, at);
    },
  });
  const drag = usePanGesture({
    activeOffsetX: [-8, 8],
    failOffsetY: [-12, 12],
    onUpdate: (e) => {
      "worklet";
      shown.value = 1;
      x.value = Math.min(Math.max(e.x - PILL_INSET - slot / 2, 0), (items.length - 1) * slot);
    },
    onDeactivate: () => {
      "worklet";
      const at = Math.round(x.value / slot);
      x.value = withSpring(at * slot, SPRING);
      scheduleOnRN(open, at);
    },
  });
  const press = useCompetingGestures(drag, tap);
  const lens = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateX: x.value }],
  }));
  return (
    <GestureDetector gesture={press}>
      <View accessibilityRole="tablist" style={[styles.pages, { width: props.width }]}>
        <Animated.View pointerEvents="none" style={[styles.pageLens, { width: slot }, lens]}>
          <View style={[styles.here, styles.fill]} />
        </Animated.View>
        {items.map(({ id, icon: Icon, label }) => {
          const here = id === props.current;
          return (
            <View
              key={id}
              accessible
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: here }}
              onAccessibilityTap={() => onOpen(id)}
              style={styles.page}
            >
              <Icon size={iconSize.md} color={here ? colors.foreground : colors.mutedForeground} />
            </View>
          );
        })}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  handle: { height: NAV_HANDLE, alignItems: "center", justifyContent: "center" },
  grabber: {
    width: space(7),
    height: space(0.75),
    borderRadius: radius.full,
    backgroundColor: colors.hairlineLine,
  },
  row: {
    height: NAV_BAR,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: EDGE,
  },
  modules: {
    height: SIDE,
    overflow: "hidden",
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  moduleRow: { height: "100%", flexDirection: "row" },
  module: { height: "100%", alignItems: "center", justifyContent: "center" },
  lens: { position: "absolute", top: 0, bottom: 0, left: 0 },
  moduleHere: {
    position: "absolute",
    top: space(1),
    bottom: space(1),
    left: space(1),
    right: space(1),
  },
  foldWrap: { overflow: "hidden" },
  actionWrap: { alignItems: "flex-end" },
  pages: {
    height: NAV_BAR,
    flexDirection: "row",
    alignItems: "center",
    padding: space(1),
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  page: {
    flex: 1,
    height: "100%",
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  pageLens: { position: "absolute", top: PILL_INSET, bottom: PILL_INSET, left: PILL_INSET },
  fill: { flex: 1 },
  here: { backgroundColor: colors.well, borderRadius: radius.full },
  pressed: { transform: [{ scale: 0.97 }] },
});
