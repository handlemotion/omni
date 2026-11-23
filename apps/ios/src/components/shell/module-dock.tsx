import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { colors, radius, space } from "@/theme/tokens.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { useModules } from "./modules.ts";

/** Height of the bottom module switcher dock row. */
export const DOCK_HEIGHT = space(10);

const SLOT = space(13);
const GAP = space(5);
const PITCH = SLOT + GAP;
const LIFT = 1.18;
const SPRING = { damping: 18, stiffness: 260, mass: 0.6 };
const HAS_GLASS = isLiquidGlassAvailable();

/**
 * The bottom dock: one tab per module, the current one on a grey pill. As on iOS 26's tab bar,
 * pressing lifts it into a Liquid Glass lens, dragging slides it across the modules (a tick as it crosses
 * each), and letting go opens the module under it; a tap does the same in place.
 */
export function ModuleDock() {
  const modules = useModules();
  const place = useMenuPlace();
  const { close } = useMenu();
  const currentIndex = Math.max(
    0,
    modules.findIndex((entry) => entry.id === place.module),
  );
  const last = modules.length - 1;
  const x = useSharedValue(currentIndex * PITCH);
  const lift = useSharedValue(0);
  const hovered = useSharedValue(currentIndex);

  const tick = () => void Haptics.selectionAsync();
  const pick = (index: number) => {
    close();
    const entry = modules[index];
    if (!entry || index === currentIndex) return;
    void Haptics.selectionAsync();
    place.openModule(entry.id);
  };

  const drag = usePanGesture({
    minDistance: 0,
    onBegin: (e) => {
      "worklet";
      lift.value = withSpring(1, SPRING);
      x.value = withSpring(Math.min(Math.max(e.x - SLOT / 2, 0), last * PITCH), SPRING);
    },
    onUpdate: (e) => {
      "worklet";
      x.value = Math.min(Math.max(e.x - SLOT / 2, 0), last * PITCH);
      const over = Math.round(x.value / PITCH);
      if (over === hovered.value) return;
      hovered.value = over;
      scheduleOnRN(tick);
    },
    onFinalize: () => {
      "worklet";
      const index = Math.round(x.value / PITCH);
      hovered.value = index;
      lift.value = withSpring(0, SPRING);
      x.value = withSpring(index * PITCH, SPRING);
      scheduleOnRN(pick, index);
    },
  });

  const lens = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { scale: 1 + (LIFT - 1) * lift.value }],
  }));

  const rest = useAnimatedStyle(() => ({ opacity: HAS_GLASS ? 1 - lift.value : 1 }));
  const lifted = useAnimatedStyle(() => ({ opacity: lift.value }));

  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={drag}>
        <Animated.View
          accessibilityRole="tablist"
          style={[styles.dock, { width: modules.length * SLOT + last * GAP }]}
        >
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
          {modules.map((entry, index) => {
            const Mark = entry.mark;
            const current = index === currentIndex;
            return (
              <View
                key={entry.id}
                accessible
                accessibilityRole="tab"
                accessibilityLabel={entry.label}
                accessibilityState={{ selected: current }}
                onAccessibilityTap={() => pick(index)}
                style={styles.slot}
              >
                <Mark size={22} />
              </View>
            );
          })}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  dock: { flexDirection: "row", alignItems: "center", gap: GAP },
  slot: { width: SLOT, height: DOCK_HEIGHT, alignItems: "center", justifyContent: "center" },
  lens: { position: "absolute", left: 0, top: 0, width: SLOT, height: DOCK_HEIGHT },
  fill: { flex: 1, borderRadius: radius.full },
  flat: { backgroundColor: colors.well },
});
