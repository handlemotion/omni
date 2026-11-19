import { Text as NativeText, type TextProps as NativeTextProps } from "react-native";
import {
  colors,
  fonts,
  text,
  type ColorToken,
  type FontWeight,
  type TextSize,
} from "@/theme/tokens.ts";

const MAX_SCALE = 1.6;

export interface TextProps extends NativeTextProps {
  size?: TextSize;
  weight?: FontWeight;
  tone?: ColorToken;
  /** Digits that line up and don't shift: counts, times. */
  tabular?: boolean;
}

/** All text in the app. Regular weight and foreground ink unless the design says otherwise. */
export function Text({
  size = "md",
  weight = "regular",
  tone = "foreground",
  tabular,
  style,
  maxFontSizeMultiplier = MAX_SCALE,
  ...props
}: TextProps) {
  return (
    <NativeText
      {...props}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[
        text[size],
        { fontFamily: fonts[weight], color: colors[tone] },
        tabular ? { fontVariant: ["tabular-nums"] } : null,
        style,
      ]}
    />
  );
}
