"use client";

import { Group, type GroupProps } from "react-aria-components/Group";
import {
  Input as InputPrimitive,
  type InputProps as InputPrimitiveProps,
} from "react-aria-components/Input";
import { cx } from "@/lib/primitive";

export interface InputProps extends Omit<InputPrimitiveProps, "size"> {
  ref?: React.RefObject<HTMLInputElement | null>;
  /** md is 32px, lg is 36px. */
  size?: "md" | "lg";
}
export function Input({ className, ref, size = "md", ...props }: InputProps) {
  return (
    <span data-slot="control" className="relative block w-full">
      <InputPrimitive
        className={cx(
          // A well: sunk one step below its surface, no border and no shadow. A field never looks
          // like a button (buttons are raised).
          "relative block w-full appearance-none rounded-lg bg-(--control-bg,var(--color-well))",
          size === "md" ? "h-8 px-2" : "h-9 px-2.5",
          "text-sm text-foreground placeholder:text-muted-foreground",
          "transition-[background-color,box-shadow] duration-150 ease-out",
          // Focus deepens the fill one step, plus a 1px focus ring (3:1 on the well). 1px, not the
          // buttons' 2px: fields autofocus on load, and a field should stay calm.
          "outline-hidden enabled:hover:bg-well-focus focus:bg-well-focus focus-visible:ring-1 focus-visible:ring-focus-ring",
          // Read-only keeps its resting fill.
          "read-only:hover:bg-(--control-bg,var(--color-well)) read-only:focus:bg-(--control-bg,var(--color-well))",
          // Invalid: a 1px red ring as a box-shadow, so nothing moves.
          "invalid:ring-1 invalid:ring-danger-subtle-foreground focus-visible:invalid:ring-danger-subtle-foreground",
          "[&::-ms-reveal]:hidden [&::-webkit-search-cancel-button]:hidden",
          "disabled:opacity-60 forced-colors:in-disabled:text-[GrayText]",
          "dark:scheme-dark",
          className,
        )}
        ref={ref}
        {...props}
      />
    </span>
  );
}

export function InputGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      data-slot="control"
      className={cx(
        "relative isolate block",
        // icon
        // icon: 15px, vertically centered, 8px from the edge; text starts 7px after it
        "has-[>[data-slot=icon]:first-child]:[&_input]:ps-7.5 has-[>[data-slot=icon]:last-child]:[&_input]:pe-7.5",
        "*:data-[slot=icon]:pointer-events-none *:data-[slot=icon]:absolute *:data-[slot=icon]:top-1/2 *:data-[slot=icon]:z-10 *:data-[slot=icon]:size-icon *:data-[slot=icon]:-translate-y-1/2",
        "[&>[data-slot=icon]:first-child]:start-2 [&>[data-slot=icon]:last-child]:end-2",

        // loader
        "has-[[data-slot=loader]:first-child]:[&_input]:ps-10 has-[[data-slot=loader]:last-child]:[&_input]:pe-10 sm:has-[[data-slot=loader]:first-child]:[&_input]:ps-8 sm:has-[[data-slot=loader]:last-child]:[&_input]:pe-8",
        "*:data-[slot=loader]:pointer-events-none *:data-[slot=loader]:absolute *:data-[slot=loader]:top-3 *:data-[slot=loader]:z-10 *:data-[slot=loader]:size-5 sm:*:data-[slot=loader]:top-2.5 sm:*:data-[slot=loader]:size-4",
        "[&>[data-slot=loader]:first-child]:start-3 sm:[&>[data-slot=loader]:first-child]:start-2.5 [&>[data-slot=loader]:last-child]:end-3 sm:[&>[data-slot=loader]:last-child]:end-2.5",

        // text
        "has-[[data-slot=text]:first-child]:[&_input]:ps-[calc(var(--input-gutter-start)+--spacing(2))] has-[[data-slot=text]:last-child]:[&_input]:pe-[calc(var(--input-gutter-end)+--spacing(2))] sm:has-[[data-slot=text]:first-child]:[&_input]:ps-(--input-gutter-start,--spacing(10)) sm:has-[[data-slot=text]:last-child]:[&_input]:pe-(--input-gutter-end,--spacing(10))",
        "*:data-[slot=text]:absolute *:data-[slot=text]:top-0 *:data-[slot=text]:z-10 *:data-[slot=text]:h-full *:data-[slot=text]:max-w-fit *:data-[slot=text]:grow *:data-[slot=text]:content-center [&>[data-slot='text']:not([class*='pointer-events'])]:pointer-events-none",
        "[&>[data-slot=text]:first-child:not([class*='start-'])]:start-3 sm:[&>[data-slot=text]:first-child:not([class*='start-'])]:start-2.5 [&>[data-slot=text]:last-child:not([class*='end-'])]:end-3 sm:[&>[data-slot=text]:last-child:not([class*='end-'])]:end-2.5",

        // keyboard
        "has-[[data-slot=keyboard]:first-child]:[&_input]:ps-[calc(var(--input-gutter-start)+--spacing(2))] has-[[data-slot=keyboard]:last-child]:[&_input]:pe-[calc(var(--input-gutter-end)+--spacing(2))] sm:has-[[data-slot=keyboard]:first-child]:[&_input]:ps-(--input-gutter-start,--spacing(10)) sm:has-[[data-slot=keyboard]:last-child]:[&_input]:pe-(--input-gutter-end,--spacing(10))",
        "*:data-[slot=keyboard]:absolute *:data-[slot=keyboard]:top-0 *:data-[slot=keyboard]:z-10 *:data-[slot=keyboard]:h-full *:data-[slot=keyboard]:max-w-fit *:data-[slot=keyboard]:grow *:data-[slot=keyboard]:content-center [&>[data-slot='keyboard']:not([class*='pointer-events'])]:pointer-events-none",
        "[&>[data-slot=keyboard]:first-child:not([class*='start-'])]:start-3 sm:[&>[data-slot=keyboard]:first-child:not([class*='start-'])]:start-2.5 [&>[data-slot=keyboard]:last-child:not([class*='end-'])]:end-3 sm:[&>[data-slot=keyboard]:last-child:not([class*='end-'])]:end-2.5",

        // button: attached to the edge, full height
        "has-[>button:not([data-inset]):first-child]:[&_input]:ps-(--input-gutter-start,--spacing(16)) has-[>button:not([data-inset]):last-child]:[&_input]:pe-(--input-gutter-end,--spacing(16)) sm:has-[>button:not([data-inset]):first-child]:[&_input]:ps-(--input-gutter-start,--spacing(14)) sm:has-[>button:not([data-inset]):last-child]:[&_input]:pe-(--input-gutter-end,--spacing(14))",
        "[&>button:not([data-inset]):first-child]:rounded-e-none [&>button:not([data-inset]):last-child]:rounded-s-none",
        "[&>button[data-intent=outline]]:border-input *:[button:not([data-inset])]:absolute *:[button:not([data-inset])]:top-0 *:[button:not([data-inset])]:z-10 *:[button:not([data-inset])]:h-full",
        "[&>button:not([data-inset]):first-child]:start-0 [&>button:not([data-inset]):last-child]:end-0",

        // button: inset (Button size="inset"), centered with an even gap to the field's edge
        "has-[>[data-inset]:last-child]:[&_input]:pe-9 sm:has-[>[data-inset]:last-child]:[&_input]:pe-8",
        "*:data-inset:absolute *:data-inset:top-1/2 *:data-inset:z-10 *:data-inset:-translate-y-1/2 *:data-inset:end-2.5 sm:*:data-inset:end-1.5",

        "[&>[data-slot='icon']:not([class*='text-'])]:text-muted-foreground [&>[data-slot='loader']:not([class*='text-'])]:text-muted-foreground [&>[data-slot='text']:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
