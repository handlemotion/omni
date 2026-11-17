"use client";

import { Keyboard as KeyboardPrimitive } from "react-aria-components/Keyboard";
import { cn } from "cn";

export function Keyboard({ className, ...props }: React.ComponentProps<typeof KeyboardPrimitive>) {
  return (
    <KeyboardPrimitive
      data-slot="keyboard"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-secondary px-1 font-sans text-xs text-muted-foreground group-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
