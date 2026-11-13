"use client";

import { Input as InputPrimitive, InputGroup as InputGroupPrimitive } from "@ui-sdk/react/input";
import { useEffect, useRef } from "react";
import { cn } from "cn";
import { useTextField } from "./text-field";

/** The field look, shared with React Aria's input in ./aria-input until its hosts move. */
export function inputClassName({
  size = "md",
  plain = false,
  invalid,
}: {
  size?: "sm" | "md" | "lg";
  plain?: boolean;
  /** The variant that marks it invalid: `data-invalid` on UI SDK, React Aria's `invalid`. */
  invalid: "data" | "aria";
}) {
  return cn(
    // Fields are white wherever they sit (on the canvas or the grey surface), so they read as
    // places to type; `--control-bg` overrides it.
    "relative block w-full appearance-none rounded-lg bg-(--control-bg,var(--color-background))",
    { sm: "h-7 px-2", md: "h-8 px-2", lg: "h-10 px-3" }[size],
    "text-sm text-foreground placeholder:text-subtle-foreground",
    plain
      ? "border-0 bg-transparent px-0 outline-hidden"
      : [
          "border border-input enabled:hover:border-muted-foreground/30",
          "outline-hidden focus:border-ring/70 focus:enabled:hover:border-ring/80",
          invalid === "data"
            ? "data-invalid:border-danger-subtle-foreground/70 data-invalid:enabled:hover:border-danger-subtle-foreground/80"
            : "invalid:border-danger-subtle-foreground/70 focus:invalid:border-danger-subtle-foreground/70 invalid:enabled:hover:border-danger-subtle-foreground/80 focus:invalid:enabled:hover:border-danger-subtle-foreground/80",
        ],
    "[&::-ms-reveal]:hidden [&::-webkit-search-cancel-button]:hidden",
    "disabled:bg-secondary in-disabled:bg-secondary forced-colors:in-disabled:text-[GrayText]",
    "dark:scheme-dark",
  );
}

export interface InputProps extends Omit<
  React.ComponentProps<"input">,
  "size" | "value" | "defaultValue" | "className"
> {
  value?: string;
  defaultValue?: string;
  className?: string;
  /** sm is 28px, md 32px, lg 40px. */
  size?: "sm" | "md" | "lg";
  /** No border or fill: a field inside a card that already frames it (the composer). */
  plain?: boolean;
}

/**
 * UI SDK's input. Inside a `TextField` it takes the field's value and attributes, and the
 * field's label, description and errors point at it.
 */
export function Input({ className, size = "md", plain = false, ref, ...props }: InputProps) {
  const field = useTextField();
  const { onValueChange, ...fromField } = field ?? {};
  const own = useRef<HTMLInputElement | null>(null);
  const autoFocus = props.autoFocus ?? fromField.autoFocus;
  // Focus from an effect, as React Aria did: it runs before a dialog's own focus effect, which
  // then sees focus already inside and leaves it there.
  useEffect(() => {
    if (autoFocus) own.current?.focus();
  }, [autoFocus]);
  return (
    <InputPrimitive
      {...fromField}
      {...props}
      ref={(node) => {
        own.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      onValueChange={onValueChange && ((value) => onValueChange(value))}
      className={cn(inputClassName({ size, plain, invalid: "data" }), className)}
    />
  );
}

/** An input with icons, text or buttons inside its edges. Presses on its text focus the input. */
export function InputGroup({
  className,
  ...props
}: React.ComponentProps<"div"> & { className?: string }) {
  return <InputGroupPrimitive {...props} className={cn(inputGroupClassName, className)} />;
}

export const inputGroupClassName = cn(
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
);
