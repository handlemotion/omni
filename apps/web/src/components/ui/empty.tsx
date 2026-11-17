import type { ComponentProps } from "react";
import { cn } from "cn";

export function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 p-12 text-center text-balance",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("flex max-w-sm flex-col items-center gap-2", className)}
      {...props}
    />
  );
}

export function EmptyMedia({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-media"
      className={cn(
        "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
}

export function EmptyDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-4 text-sm text-balance",
        className,
      )}
      {...props}
    />
  );
}
