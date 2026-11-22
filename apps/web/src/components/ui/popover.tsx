"use client";

import {
  Popover as PopoverRoot,
  PopoverArrow,
  PopoverContent,
  PopoverTrigger as PopoverTriggerPrimitive,
  createPopoverController,
} from "@ui-sdk/react/popover";
import { Children, type ReactElement, type ReactNode } from "react";
import { cn } from "cn";
import { toSideAlign, type Placement } from "./placement";

/** The raised surface every popup shares: popovers, menus. */
export const popupSurface = cn(
  "max-h-[calc(var(--available-height)-16px)] min-w-(--anchor-width) max-w-xs origin-(--transform-origin)",
  "rounded-(--popover-radius) border border-border bg-overlay text-overlay-foreground shadow-(--shadow-overlay) outline-hidden [--popover-radius:var(--radius-lg)] sm:text-sm",
  "dark:ring-border dark:backdrop-saturate-200 forced-colors:bg-[Canvas]",
  "transition-[opacity,scale] duration-150 ease-out data-ending-style:duration-120",
  "data-starting-style:scale-97 data-starting-style:opacity-0 data-ending-style:scale-97 data-ending-style:opacity-0",
  "motion-reduce:data-starting-style:scale-100 motion-reduce:data-ending-style:scale-100",
);

/** A popover opened from code (a menu item, a shortcut) instead of a trigger: pass it a controller. */
export { PopoverRoot, createPopoverController };

export interface PopoverTriggerProps {
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger element first, then its `<Popover>`. */
  children: ReactNode;
}

/**
 * Keeps React Aria's shape (`<PopoverTrigger><Button/><Popover/></PopoverTrigger>`) on UI SDK's
 * parts: the first child becomes the trigger through `render`, so it must forward its props and
 * ref to its DOM element.
 */
export function PopoverTrigger({
  isOpen,
  defaultOpen,
  onOpenChange,
  children,
}: PopoverTriggerProps) {
  const [trigger, ...rest] = Children.toArray(children);
  return (
    <PopoverRoot
      open={isOpen}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange && ((open) => onOpenChange(open))}
    >
      <PopoverTriggerPrimitive render={trigger as ReactElement<Record<string, unknown>>} />
      {rest}
    </PopoverRoot>
  );
}

export interface PopoverProps {
  placement?: Placement;
  /** Gap to the trigger, in pixels. */
  offset?: number;
  arrow?: boolean;
  /** Room kept from the viewport's edges, in pixels. */
  collisionPadding?: number;
  className?: string;
  /** Names the popover when it has no `PopoverTitle`. */
  "aria-label"?: string;
  children?: ReactNode;
}

/** The popover's content, inside a `PopoverTrigger`. It is a non-modal dialog. */
export function Popover({
  placement = "bottom",
  offset,
  arrow = false,
  collisionPadding = 16,
  className,
  children,
  ...props
}: PopoverProps) {
  return (
    <PopoverContent
      {...toSideAlign(placement)}
      sideOffset={offset ?? (arrow ? 12 : 8)}
      collisionPadding={collisionPadding}
      className={cn("group/popover flex flex-col", popupSurface, className)}
      {...props}
    >
      {arrow && (
        <PopoverArrow className="group-data-[side=top]/popover:top-full group-data-[side=bottom]/popover:bottom-full group-data-[side=left]/popover:left-full group-data-[side=right]/popover:right-full">
          <svg
            width={12}
            height={12}
            viewBox="0 0 12 12"
            aria-hidden
            className="block fill-overlay stroke-border group-data-[side=bottom]/popover:rotate-180 group-data-[side=left]/popover:-rotate-90 group-data-[side=right]/popover:rotate-90 forced-colors:fill-[Canvas] forced-colors:stroke-[ButtonBorder]"
          >
            <path d="M0 0 L6 6 L12 0" />
          </svg>
        </PopoverArrow>
      )}
      {children}
    </PopoverContent>
  );
}
