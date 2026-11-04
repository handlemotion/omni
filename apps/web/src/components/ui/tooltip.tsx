import { composeRenderProps } from "react-aria-components/composeRenderProps";
import type { TooltipProps as TooltipPrimitiveProps } from "react-aria-components/Tooltip";
import {
  OverlayArrow,
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "react-aria-components/Tooltip";
import { twJoin } from "cn";
import type { VariantProps } from "tailwind-variants";
import { tv } from "tailwind-variants";

// shadcn's tooltip look on React Aria's tooltip: a small dark chip (foreground on background),
// 12px text, a short fade and zoom from its trigger. `inverse={false}` keeps the light overlay.
const tooltipStyles = tv({
  base: [
    "group w-fit max-w-xs origin-(--trigger-anchor-point) rounded-md px-3 py-1.5 text-xs text-balance will-change-transform *:[strong]:font-medium",
  ],
  variants: {
    inverse: {
      true: ["bg-foreground text-background", "**:[.text-muted-foreground]:text-background/60"],
      false: "border border-border bg-overlay text-overlay-foreground",
    },
    isEntering: {
      true: "fade-in-0 zoom-in-95 animate-in duration-150 ease-out motion-reduce:animate-none",
    },
    isExiting: {
      true: "fade-out-0 zoom-out-95 animate-out duration-100 ease-out motion-reduce:animate-none",
    },
  },
  defaultVariants: {
    inverse: true,
  },
});

export const TooltipTrigger = TooltipTriggerPrimitive;

export interface TooltipProps
  extends Omit<TooltipPrimitiveProps, "children">, VariantProps<typeof tooltipStyles> {
  arrow?: boolean;
  children?: React.ReactNode;
}

export function Tooltip({ offset = 6, arrow = true, inverse, children, ...props }: TooltipProps) {
  return (
    <TooltipPrimitive
      {...props}
      offset={offset}
      className={composeRenderProps(props.className, (className, renderProps) =>
        tooltipStyles({
          ...renderProps,
          inverse,
          className,
        }),
      )}
    >
      {arrow && (
        <OverlayArrow className="group">
          <svg
            width={10}
            height={5}
            viewBox="0 0 10 5"
            className={twJoin(
              "block group-placement-bottom:rotate-180 group-placement-left:-rotate-90 group-placement-right:rotate-90 forced-colors:fill-[Canvas] forced-colors:stroke-[ButtonBorder]",
              inverse === false
                ? "fill-overlay stroke-border"
                : "fill-foreground stroke-transparent",
            )}
          >
            <path d="M0 0 L5 5 L10 0" />
          </svg>
        </OverlayArrow>
      )}
      {children}
    </TooltipPrimitive>
  );
}
