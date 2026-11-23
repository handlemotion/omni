import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { StyleSheet, View } from "react-native";
import {
  GestureDetector,
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { colors, radius, space } from "@/theme/tokens.ts";
import { useMenuPlace } from "./menu-nav.ts";
import { useModules } from "./modules.ts";

/** Height of the bottom module switcher dock row. */
export const DOCK_HEIGHT = space(10);

const SLOT = space(15);
const TAP_SLOP = 10;
const LIFT = 1.12;
const SPRING = { damping: 18, stiffness: 260, mass: 0.6 };
const HAS_GLASS = isLiquidGlassAvailable();

/**
 * The bottom dock: the modules side by side, the current one on a pill, on the grey surface
 * under the page. A tap opens a module; dragging sideways lifts the pill into a Liquid Glass lens
 * that slides across the modules (a tick as it crosses each) and opens the one it is let go on. A
 * vertical drag is left to the section around it. `follow` (a module index, fractional mid-swipe)
 * moves the pill with the pages under the dock.
 */
export function ModuleDock({ follow }: { follow?: SharedValue<number> }) {
  const modules = useModules();
  const place = useMenuPlace();
  const current = Math.max(
    0,
    modules.findIndex((entry) => entry.id === place.module),
  );
  const slots = modules.length;
  const x = useSharedValue(current * SLOT);
  const lift = useSharedValue(0);
  const hovered = useSharedValue(current);

  useAnimatedReaction(
    () => follow?.value,
    (at, before) => {
      if (at === undefined || before === undefined || at === before || lift.value > 0) return;
      x.value = at * SLOT;
    },
  );

  const tick = () => void Haptics.selectionAsync();
  const pick = (index: number) => {
    const entry = modules[index];
    if (!entry || index === current) return;
    void Haptics.selectionAsync();
    place.openModule(entry.id);
  };

  const slotUnder = (touchX: number) => {
    "worklet";
    return Math.min(Math.max(Math.floor(touchX / SLOT), 0), slots - 1);
  };
  const settle = (index: number) => {
    "worklet";
    hovered.value = index;
    lift.value = withSpring(0, SPRING);
    x.value = withSpring(index * SLOT, SPRING);
  };
  const tap = useTapGesture({
    maxDistance: TAP_SLOP,
    onActivate: (e) => {
      "worklet";
      const index = slotUnder(e.x);
      settle(index);
      scheduleOnRN(pick, index);
    },
  });
  const drag = usePanGesture({
    activeOffsetX: [-8, 8],
    failOffsetY: [-TAP_SLOP, TAP_SLOP],
    onActivate: () => {
      "worklet";
      lift.value = withSpring(1, SPRING);
    },
    onUpdate: (e) => {
      "worklet";
      x.value = Math.min(Math.max(e.x - SLOT / 2, 0), (slots - 1) * SLOT);
      const over = Math.round(x.value / SLOT);
      if (over === hovered.value) return;
      hovered.value = over;
      scheduleOnRN(tick);
    },
    onDeactivate: (e) => {
      "worklet";
      const index = e.canceled ? current : hovered.value;
      settle(index);
      scheduleOnRN(pick, index);
    },
  });
  const press = useCompetingGestures(drag, tap);

  const lens = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { scale: 1 + (LIFT - 1) * lift.value }],
  }));
  const rest = useAnimatedStyle(() => ({ opacity: HAS_GLASS ? 1 - lift.value : 1 }));
  const lifted = useAnimatedStyle(() => ({ opacity: lift.value }));

  const slot = (index: number) => {
    const entry = modules[index];
    if (!entry) return null;
    const Mark = entry.mark;
    return (
      <View
        key={entry.id}
        accessible
        accessibilityRole="tab"
        accessibilityLabel={entry.label}
        accessibilityState={{ selected: index === current }}
        onAccessibilityTap={() => pick(index)}
        style={styles.slot}
      >
        <Mark size={22} />
      </View>
    );
  };

  return (
    <GestureDetector gesture={press}>
      <Animated.View accessibilityRole="tablist" style={[styles.dock, { width: slots * SLOT }]}>
        <Animated.View pointerEvents="none" style={[styles.lens, lens]}>
          <Animated.View style={[styles.fill, styles.flat, rest]} />
          {HAS_GLASS ? (
            <Animated.View style={[StyleSheet.absoluteFill, lifted]}>
              <GlassView
                glassEffectStyle="regular"
                colorScheme="light"
                isInteractive
                style={styles.fill}
              />
            </Animated.View>
          ) : null}
        </Animated.View>
        {modules.map((_, index) => slot(index))}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  dock: { flexDirection: "row", alignItems: "center", alignSelf: "center" },
  slot: { width: SLOT, height: DOCK_HEIGHT, alignItems: "center", justifyContent: "center" },
  lens: {
    position: "absolute",
    left: 0,
    top: 0,
    width: SLOT,
    height: DOCK_HEIGHT,
    paddingHorizontal: space(1),
  },
  fill: { flex: 1, borderRadius: radius.full },
  flat: { backgroundColor: colors.underFill },
});
