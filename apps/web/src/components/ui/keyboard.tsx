"use client";

import { Keyboard as KeyboardPrimitive } from "react-aria-components/Keyboard";
import { cn } from "cn";

export function Keyboard({ className, ...props }: React.ComponentProps<typeof KeyboardPrimitive>) {
  return (
    <KeyboardPrimitive
      data-slot="keyboard"
      className={cn(
        // A key hint ("Esc", "/"): a chip tinted from its own text colour, so it suits any surface,
        // no border. `font-sans` because <kbd> defaults to monospace, whose metrics sit the text
        // off-center. Hidden on touch screens: there are no keys to press.
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs bg-current/14 px-1.5 font-sans text-xs text-muted-foreground group-disabled:opacity-50 pointer-coarse:hidden",
        className,
      )}
      {...props}
    />
  );
}
