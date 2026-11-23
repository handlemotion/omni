import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "@/theme/tokens.ts";

const BLUE = "#0e2896";
const CREAM = "#f2e4c8";

/** Omni's mark, the ceramic globe, flat: the web's `IconOmniMark` at its 28pt size. */
export function OmniMark({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" accessible={false}>
      <Rect width={28} height={28} rx={6.25} fill={BLUE} />
      <Circle cx={14} cy={14} r={10.08} fill={CREAM} />
      <Path
        fill={BLUE}
        d="M14 3.92A10.728 10.728 0 0 0 14 24.08A12.919 12.919 0 0 1 14 3.92ZM14 3.92A10.728 10.728 0 0 1 14 24.08A12.919 12.919 0 0 0 14 3.92Z"
      />
    </Svg>
  );
}

/** The globe from the Omni mark alone, no backdrop tile: the web's `IconOmniGlobe`. */
export function OmniGlobe({
  size = 44,
  color = colors.brandCream,
}: {
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="3.92 3.92 20.16 20.16" accessible={false}>
      <Path
        fill={color}
        fillRule="evenodd"
        d="M3.92 14a10.08 10.08 0 1 0 20.16 0a10.08 10.08 0 1 0 -20.16 0ZM14 3.92A10.728 10.728 0 0 0 14 24.08A12.919 12.919 0 0 1 14 3.92ZM14 3.92A10.728 10.728 0 0 1 14 24.08A12.919 12.919 0 0 0 14 3.92Z"
      />
    </Svg>
  );
}
