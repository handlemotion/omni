import { useEffect } from "react";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { useReduceMotion } from "./use-reduce-motion.ts";

/** Minimal ring stroke spinner matching the web's `Loader`, for pending buttons and controls. */
export function Spinner({ size = 18, color }: { size?: number; color: string }) {
  const still = useReduceMotion();
  const angle = useSharedValue(0);

  useEffect(() => {
    if (still) {
      angle.value = 0;
      return;
    }
    angle.value = 0;
    angle.value = withRepeat(withTiming(360, { duration: 750, easing: Easing.linear }), -1, false);
  }, [still, angle]);

  const spin = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }));

  return (
    <Animated.View style={[{ width: size, height: size }, spin]}>
      <Svg width={size} height={size} viewBox="0 0 15 15" fill="none" accessible={false}>
        <Circle
          cx={7.5}
          cy={7.5}
          r={6}
          stroke={color}
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeDasharray="28 38"
        />
      </Svg>
    </Animated.View>
  );
}
