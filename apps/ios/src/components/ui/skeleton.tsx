import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, StyleSheet, type DimensionValue } from "react-native";
import { colors, radius } from "@/theme/tokens.ts";

/**
 * A placeholder bar for data on its way, shaped like the text it stands for. The web uses
 * `skullet`, which has no React Native build; this is its stand-in. It breathes slowly, and holds
 * still when Reduce Motion is on.
 */
export function Skeleton({ width, height = 12 }: { width: DimensionValue; height?: number }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    const start = async () => {
      if (!(await AccessibilityInfo.isReduceMotionEnabled())) loop.start();
    };
    void start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[styles.bar, { width, height, opacity }]} />;
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.accent, borderRadius: radius.sm },
});
