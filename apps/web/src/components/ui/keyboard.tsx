"use client";

import { Keyboard as KeyboardPrimitive } from "react-aria-components/Keyboard";
import { cn } from "cn";

export function Keyboard({ className, ...props }: React.ComponentProps<typeof KeyboardPrimitive>) {
  return (
    <KeyboardPrimitive
      data-slot="keyboard"
      className={cn(
        // A key hint ("Esc", "/"): a grey key cap, no border. `font-sans` because <kbd> defaults
        // to monospace, whose metrics sit the text off-center.
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-secondary px-1 font-sans text-xs text-muted-foreground group-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
