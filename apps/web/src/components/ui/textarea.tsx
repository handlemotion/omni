"use client";

import { Textarea as TextareaPrimitive } from "@ui-sdk/react/textarea";
import { cn } from "cn";

export interface TextAreaProps extends Omit<
  React.ComponentProps<"textarea">,
  "value" | "defaultValue" | "className" | "onSubmit"
> {
  value?: string;
  defaultValue?: string;
  className?: string;
  /** No border or fill: a field inside a card that already frames it (the composer). */
  plain?: boolean;
}

/** UI SDK's textarea; it grows with its text (`field-sizing: content`) up to the caller's max-height. */
export function Textarea({ className, plain = false, ...props }: TextAreaProps) {
  return (
    <TextareaPrimitive
      {...props}
      className={cn(
        "field-sizing-content relative block min-h-16 w-full appearance-none rounded-lg bg-(--control-bg,var(--color-background)) px-[calc(--spacing(3.5)-1px)] py-[calc(--spacing(2.5)-1px)] sm:px-[calc(--spacing(3)-1px)] sm:py-[calc(--spacing(1.5)-1px)]",
        "text-base/6 text-foreground placeholder:text-muted-foreground sm:text-sm/6",
        plain
          ? "border-0 bg-transparent px-0 sm:px-0 outline-hidden"
          : [
              "border border-input enabled:hover:border-muted-foreground/30",
              "outline-hidden focus:border-ring/70 focus:enabled:hover:border-ring/80",
              "data-invalid:border-danger-subtle-foreground/70 data-invalid:enabled:hover:border-danger-subtle-foreground/80",
            ],
        "disabled:bg-muted forced-colors:in-disabled:text-[GrayText]",
        "in-disabled:bg-muted forced-colors:in-disabled:text-[GrayText]",
        "dark:scheme-dark",
        className,
      )}
    />
  );
}
