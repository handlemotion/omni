import { StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors } from "@/theme/tokens.ts";

const FADE_HEIGHT = 128;

/**
 * The page dissolving lightly into the canvas along the bottom edge, behind the dock: clear at
 * the top, easing into the background toward the bottom. Touches pass through it.
 */
export function BottomFade() {
  return (
    <View pointerEvents="none" style={styles.fade}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="bottom-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.background} stopOpacity={0} />
            <Stop offset="0.48" stopColor={colors.background} stopOpacity={0.5} />
            <Stop offset="0.82" stopColor={colors.background} stopOpacity={0.92} />
            <Stop offset="1" stopColor={colors.background} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#bottom-fade)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: FADE_HEIGHT },
});
