import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * A pressable thing placed on a canvas by its own coordinates (an event on the calendar's grid),
 * where a styled `Button` would fight the layout and React Aria's press handling would swallow
 * the pointer events a drag needs. Unstyled but for the focus ring; the caller places and paints it.
 */
export function CanvasButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn("outline-hidden focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    />
  );
}
