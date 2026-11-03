"use client";

import {
  OverlayArrow,
  Popover as PopoverPrimitive,
  type PopoverProps as PopoverPrimitiveProps,
} from "react-aria-components/Popover";
import { cx } from "@/lib/primitive";
import {
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

export const PopoverTrigger = DialogTrigger;

export const PopoverTitle = DialogTitle;
export const PopoverHeader = DialogHeader;
export const PopoverBody = DialogBody;
export const PopoverFooter = DialogFooter;

export interface PopoverProps extends PopoverPrimitiveProps {
  arrow?: boolean;
  ref?: React.Ref<HTMLDivElement>;
}

export function Popover({ children, arrow = false, className, ref, ...props }: PopoverProps) {
  const offset = props.offset ?? (arrow ? 12 : 8);
  return (
    <PopoverPrimitive
      ref={ref}
      offset={offset}
      className={cx(
        "[--visual-viewport-vertical-padding:16px] sm:[--visual-viewport-vertical-padding:32px]",
        "max-h-[calc(var(--visual-viewport-height)-var(--visual-viewport-vertical-padding)*2)]",
        // White, with the menu shadow's 1px ring as its edge: crisp, no big soft blur.
        "group/popover min-w-(--trigger-width) max-w-xs origin-(--trigger-anchor-point) rounded-(--popover-radius) bg-overlay text-overlay-foreground shadow-(--shadow-menu) outline-hidden [--gutter:--spacing(6)] [--popover-radius:var(--radius-xl)] sm:text-sm dark:backdrop-saturate-200 **:[[role=dialog]]:[--gutter:--spacing(6)]",
        // Grows from the trigger: in 150ms from scale .97 and a fade, out faster (120ms). Under
        // reduced motion only the fade remains.
        "entering:animate-in entering:fade-in entering:zoom-in-97 entering:duration-150 entering:ease-out",
        "exiting:animate-out exiting:fade-out exiting:zoom-out-97 exiting:duration-120 exiting:ease-out",
        "motion-reduce:entering:zoom-in-100 motion-reduce:exiting:zoom-out-100",
        "forced-colors:bg-[Canvas]",
        className,
      )}
      {...props}
    >
      {(values) => (
        <>
          {arrow && (
            <OverlayArrow className="group">
              <svg
                width={12}
                height={12}
                viewBox="0 0 12 12"
                className="block fill-overlay stroke-border group-placement-bottom:rotate-180 group-placement-left:-rotate-90 group-placement-right:rotate-90 forced-colors:fill-[Canvas] forced-colors:stroke-[ButtonBorder]"
              >
                <path d="M0 0 L6 6 L12 0" />
              </svg>
            </OverlayArrow>
          )}
          <div data-slot="popover-inner" className="max-h-[inherit] overflow-y-auto flex flex-col">
            {typeof children === "function" ? children(values) : children}
          </div>
        </>
      )}
    </PopoverPrimitive>
  );
}

export const PopoverClose = DialogClose;
export const PopoverDescription = DialogDescription;
