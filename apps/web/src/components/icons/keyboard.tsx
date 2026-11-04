// A keyboard, for the Shortcuts page. Not from the Figma file (it has none, nor does heroicons):
// drawn on the Figma icons' 15px grid with their 0.9375 stroke and round caps, so it sits beside
// them in the settings nav. `currentColor` and decorative, like the others.
import type { SVGProps } from "react";

export const IconKeyboard = (props: SVGProps<SVGSVGElement>) => (
  <svg
    data-slot="icon"
    width="15"
    height="15"
    viewBox="0 0 15 15"
    fill="none"
    aria-hidden
    {...props}
  >
    {/* The case: the inbox icon's 12.8px span, a little shorter than the gear so it reads wide. */}
    <rect
      x="1.09375"
      y="3.28125"
      width="12.8125"
      height="8.4375"
      rx="1.25"
      strokeWidth="0.9375"
      stroke="currentColor"
    />
    {/* Two rows of keys as short marks, then the space bar. */}
    <path
      d="M3.75 5.78125H4.0625M5.9375 5.78125H6.25M8.75 5.78125H9.0625M10.9375 5.78125H11.25M3.75 7.5H4.0625M5.9375 7.5H6.25M8.75 7.5H9.0625M10.9375 7.5H11.25M5.3125 9.375H9.6875"
      strokeWidth="0.9375"
      strokeLinecap="round"
      stroke="currentColor"
    />
  </svg>
);
