import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, floatingFade } from "@/theme/tokens.ts";

/**
 * The page dissolving into the canvas along the bottom edge, behind the floating bar: clear at
 * the top, the background from 62% down. Touches pass through it.
 */
export function BottomFade() {
  return (
    <View pointerEvents="none" style={styles.fade}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="bottom-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.background} stopOpacity={0} />
            <Stop offset="0.62" stopColor={colors.background} stopOpacity={1} />
            <Stop offset="1" stopColor={colors.background} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#bottom-fade)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: floatingFade },
});
