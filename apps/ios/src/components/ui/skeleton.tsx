import { useEffect } from "react";
import { AccessibilityInfo, Animated, StyleSheet, type DimensionValue } from "react-native";
import { colors, radius } from "@/theme/tokens.ts";

const sharedPulse = new Animated.Value(1);
const loop = Animated.loop(
  Animated.sequence([
    Animated.timing(sharedPulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
    Animated.timing(sharedPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
  ]),
);
let mounted = 0;

function usePulse() {
  useEffect(() => {
    mounted += 1;
    if (mounted === 1) {
      void AccessibilityInfo.isReduceMotionEnabled().then((still) => {
        if (!still && mounted > 0) loop.start();
      });
    }
    return () => {
      mounted -= 1;
      if (mounted === 0) {
        loop.stop();
        loop.reset();
        sharedPulse.setValue(1);
      }
    };
  }, []);
}

/**
 * A placeholder bar for data on its way, shaped like the text it stands for. The web uses
 * `skullet`, which has no React Native build; this is its stand-in. Every bar breathes in step,
 * and holds still when Reduce Motion is on. `round` makes it a circle `height` across, for an
 * avatar; `corner` sets the corner radius for a square lead (a file or folder tile).
 */
export function Skeleton({
  width,
  height = 12,
  aspectRatio,
  round = false,
  corner,
}: {
  width: DimensionValue;
  height?: number;
  aspectRatio?: number;
  round?: boolean;
  corner?: number;
}) {
  usePulse();
  return (
    <Animated.View
      style={[
        styles.bar,
        round && styles.round,
        corner !== undefined && { borderRadius: corner },
        {
          width: round ? height : width,
          ...(aspectRatio === undefined ? { height } : { aspectRatio }),
          opacity: sharedPulse,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.accent, borderRadius: radius.sm },
  round: { borderRadius: radius.full },
});
