import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, space } from "@/theme/tokens.ts";

const HEADER = 44;
const TAIL = space(6);

function TopFade() {
  const height = useSafeAreaInsets().top + HEADER + TAIL;
  return (
    <View pointerEvents="none" style={[styles.fade, { height }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="screen-top-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.background} stopOpacity={1} />
            <Stop offset="0.62" stopColor={colors.background} stopOpacity={0.92} />
            <Stop offset="1" stopColor={colors.background} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#screen-top-fade)" />
      </Svg>
    </View>
  );
}

/** Every pushed screen with a native header: the canvas fading out under it, as the root pages do. */
export function withTopFade({
  options,
  children,
}: {
  options: { headerShown?: boolean; presentation?: string };
  children: ReactNode;
}) {
  const bare = options.headerShown === false || options.presentation?.includes("heet");
  return (
    <View style={styles.fill}>
      {children}
      {bare ? null : <TopFade />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  fade: { position: "absolute", top: 0, left: 0, right: 0 },
});
