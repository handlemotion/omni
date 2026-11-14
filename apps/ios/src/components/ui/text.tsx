import { Text as NativeText, type TextProps as NativeTextProps } from "react-native";
import {
  colors,
  fonts,
  text,
  type ColorToken,
  type FontWeight,
  type TextSize,
} from "@/theme/tokens.ts";

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
  ...props
}: TextProps) {
  return (
    <NativeText
      {...props}
      style={[
        text[size],
        { fontFamily: fonts[weight], color: colors[tone] },
        tabular ? { fontVariant: ["tabular-nums"] } : null,
        style,
      ]}
    />
  );
}
