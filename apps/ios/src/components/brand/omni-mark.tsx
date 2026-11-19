import Svg, { Path } from "react-native-svg";
import { colors } from "@/theme/tokens.ts";

/** Omni's mark, the web sign-in card's `IconRedirectArrow`, at its 28pt size. */
export function OmniMark({ size = 28 }: { size?: number }) {
  const stroke = { stroke: colors.primary, strokeWidth: 1.6875 } as const;
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" fill="none" accessible={false}>
      <Path
        d="M14 23.625V14M14 14V9.1875C14 6.52963 11.8454 4.375 9.1875 4.375C6.52963 4.375 4.375 6.52963 4.375 9.1875C4.375 11.8454 6.52963 14 9.1875 14H14ZM14 14H23.3333"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...stroke}
      />
      <Path
        d="M19.5417 9.91667L23.625 14L19.5417 18.0833"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...stroke}
      />
    </Svg>
  );
}
