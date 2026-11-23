import MaskedViewClass, { type MaskedViewProps } from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { useId, type ComponentType } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { colors, space } from "@/theme/tokens.ts";

const MaskedView = MaskedViewClass as unknown as ComponentType<MaskedViewProps>;

/**
 * The page warping out under chrome at a screen edge, as iOS 26 scroll edges do: a blur that
 * thickens toward the edge, masked so it starts from nothing, with the canvas washing over it.
 * `solid` is how many points at the edge are fully covered (content is gone there); the rest
 * of `height` is the short ramp. Touches pass through.
 */
export function EdgeBlur({
  edge,
  height,
  solid = 0,
  intensity = 24,
  wash = true,
}: {
  edge: "top" | "bottom";
  height: number;
  solid?: number;
  intensity?: number;
  /** Lay the canvas colour over the blur; off where the edge crosses other surfaces (the drawer). */
  wash?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const top = edge === "top";
  const hold = Math.min(1, solid / height);
  const at = (offset: number) => (top ? offset : 1 - offset);
  const stops = (opacities: [number, number][]) =>
    (top ? opacities : [...opacities].reverse()).map(([offset, opacity]) => (
      <Stop key={offset} offset={at(offset)} stopColor={colors.background} stopOpacity={opacity} />
    ));
  const ramp = (from: number) => hold + (1 - hold) * from;

  return (
    <View pointerEvents="none" style={[styles.edge, top ? styles.top : styles.bottom, { height }]}>
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id={`${id}m`} x1="0" y1="0" x2="0" y2="1">
                {stops([
                  [0, 1],
                  [ramp(0.35), 1],
                  [1, 0],
                ])}
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill={`url(#${id}m)`} />
          </Svg>
        }
      >
        <BlurView intensity={intensity} tint="light" style={StyleSheet.absoluteFill} />
      </MaskedView>
      {wash ? (
        <>
          <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id={`${id}w`} x1="0" y1="0" x2="0" y2="1">
                {stops([
                  [0, 1],
                  [hold, 1],
                  [ramp(0.45), 0.7],
                  [1, 0],
                ])}
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill={`url(#${id}w)`} />
          </Svg>
          <View style={[styles.solid, top ? styles.top : styles.bottom, { height: solid }]} />
        </>
      ) : null}
    </View>
  );
}

/** The one top edge in the app: a short blur behind the clock and battery, over every page. */
export function StatusBarBlur() {
  const insets = useSafeAreaInsets();
  return (
    <EdgeBlur edge="top" height={insets.top + space(4)} solid={insets.top * 0.5} wash={false} />
  );
}

/**
 * The page fading out across the middle of a bar floating at the bottom edge (the search bar,
 * a conversation's actions), gone by the bar's lower half. `middle` is the screen edge to the
 * bar's middle.
 */
export function BarFade({ middle }: { middle: number }) {
  return (
    <EdgeBlur edge="bottom" height={middle + space(3)} solid={middle - space(3)} intensity={12} />
  );
}

const styles = StyleSheet.create({
  edge: { position: "absolute", left: 0, right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 },
  solid: { position: "absolute", left: 0, right: 0, backgroundColor: colors.background },
});
