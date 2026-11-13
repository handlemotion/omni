import {
  Tooltip as TooltipRoot,
  TooltipArrow,
  TooltipContent,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { twJoin } from "cn";
import type { VariantProps } from "tailwind-variants";
import { tv } from "tailwind-variants";
import { toSideAlign, type Placement } from "./placement";

// shadcn's tooltip look on UI SDK's tooltip: a small dark chip (foreground on background),
// 12px text, a short fade and zoom from its trigger. `inverse={false}` keeps the light overlay.
const tooltipStyles = tv({
  base: [
    "group w-fit max-w-xs origin-(--transform-origin) rounded-md px-3 py-1.5 text-xs text-balance *:[strong]:font-medium",
    "transition-[opacity,scale] duration-150 ease-out data-ending-style:duration-100 motion-reduce:transition-none",
    "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none",
  ],
  variants: {
    inverse: {
      true: ["bg-foreground text-background", "**:[.text-muted-foreground]:text-background/60"],
      false: "border border-border bg-overlay text-overlay-foreground",
    },
  },
  defaultVariants: {
    inverse: true,
  },
});

export interface TooltipTriggerProps {
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Milliseconds the pointer rests on the trigger before the tooltip opens. */
  delay?: number;
  closeDelay?: number;
  isDisabled?: boolean;
  /** The trigger element first, then its `<Tooltip>`. */
  children: ReactNode;
  /** Props another component's trigger part passes on (a menu's), for the trigger element. */
  [prop: string]: unknown;
}

/**
 * Keeps React Aria's shape (`<TooltipTrigger><Button/><Tooltip/></TooltipTrigger>`) on UI SDK's
 * parts: the first child becomes the trigger through `render`, so it must forward its props and
 * ref to its DOM element. A `<Tooltip hidden>` turns the tooltip off but keeps the trigger. Inside
 * a `MenuTrigger` or `PopoverTrigger`, the props and ref that trigger passes reach the element too.
 */
export function TooltipTrigger({
  delay,
  closeDelay,
  isDisabled,
  isOpen,
  onOpenChange,
  children,
  ...forwarded
}: TooltipTriggerProps) {
  const [trigger, ...rest] = Children.toArray(children);
  const tooltip = rest.find(
    (child): child is ReactElement<TooltipProps> => isValidElement(child) && child.type === Tooltip,
  );
  return (
    <TooltipRoot
      open={isOpen}
      onOpenChange={onOpenChange && ((open) => onOpenChange(open))}
      delay={delay}
      closeDelay={closeDelay}
      disabled={isDisabled || Boolean(tooltip?.props.hidden)}
    >
      <TooltipTriggerPrimitive
        {...forwarded}
        render={trigger as ReactElement<Record<string, unknown>>}
      />
      {rest}
    </TooltipRoot>
  );
}

export interface TooltipProps extends VariantProps<typeof tooltipStyles> {
  arrow?: boolean;
  placement?: Placement;
  /** Gap to the trigger, in pixels. */
  offset?: number;
  className?: string;
  hidden?: boolean;
  children?: ReactNode;
}

export function Tooltip({
  offset = 6,
  arrow = true,
  inverse,
  placement = "top",
  className,
  hidden,
  children,
}: TooltipProps) {
  if (hidden) return null;
  return (
    <TooltipContent
      {...toSideAlign(placement)}
      sideOffset={offset}
      className={tooltipStyles({ inverse, className })}
    >
      {arrow && (
        <TooltipArrow className="group-data-[side=top]:top-full group-data-[side=bottom]:bottom-full group-data-[side=left]:left-full group-data-[side=right]:right-full">
          <svg
            width={10}
            height={5}
            viewBox="0 0 10 5"
            aria-hidden
            className={twJoin(
              "block group-data-[side=bottom]:rotate-180 group-data-[side=left]:-rotate-90 group-data-[side=right]:rotate-90 forced-colors:fill-[Canvas] forced-colors:stroke-[ButtonBorder]",
              inverse === false
                ? "fill-overlay stroke-border"
                : "fill-foreground stroke-transparent",
            )}
          >
            <path d="M0 0 L5 5 L10 0" />
          </svg>
        </TooltipArrow>
      )}
      {children}
    </TooltipContent>
  );
}
