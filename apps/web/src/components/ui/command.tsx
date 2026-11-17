"use client";

// Ported from transitive (`packages/ui/src/components/ui/command.tsx`) onto our Dialog and
// tokens: a cmdk command menu in a centred modal over the scrim. The list's fluid hover follows
// cmdk's selected row (keyboard or pointer), so rows carry no fill of their own.
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "cn";
import type { ReactNode } from "react";
import { ToggleButton } from "react-aria-components/ToggleButton";
import { ToggleButtonGroup } from "react-aria-components/ToggleButtonGroup";
import { Dialog, type DialogProps } from "./dialog";
import { FluidHoverHighlight } from "./fluid-hover-highlight";
import { Keyboard } from "./keyboard";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden bg-background text-foreground outline-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function CommandDialog({
  label,
  className,
  children,
  ...props
}: Omit<DialogProps, "children" | "aria-label" | "size" | "bare" | "closeButton"> & {
  /** Read by screen readers; nothing on screen titles the menu. */
  label: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      aria-label={label}
      bare
      closeButton={false}
      className={cn(
        // Optical centre: a little above the true middle, as transitive's sits.
        "-translate-y-6 rounded-2xl sm:max-w-[min(calc(100vw-24px),640px)]",
        className,
      )}
      {...props}
    >
      {children}
    </Dialog>
  );
}

export function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="border-b border-border/50 px-4">
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-13 w-full bg-transparent text-[15px] text-foreground outline-hidden placeholder:text-subtle-foreground",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/**
 * The pills under the field that scope what the menu searches (transitive's filter pills). The
 * field keeps the keyboard: `onChange` is the caller's cue to focus it again.
 */
export function CommandScopes<T extends string>({
  scopes,
  value,
  onChange,
}: {
  scopes: readonly { id: T; label: string }[];
  value: T;
  onChange: (scope: T) => void;
}) {
  return (
    <ToggleButtonGroup
      aria-label="Search in"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [next] = keys;
        if (next !== undefined) onChange(next as T);
      }}
      data-slot="command-scopes"
      className="flex min-h-11 items-center gap-1 overflow-x-auto overflow-y-clip px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {scopes.map((scope) => (
        <ToggleButton
          key={scope.id}
          id={scope.id}
          className="flex h-7 shrink-0 cursor-default items-center rounded-full px-2.5 text-sm text-muted-foreground outline-hidden transition-colors hover:bg-hover hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground selected:bg-secondary selected:text-foreground"
        >
          {scope.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export function CommandList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  const hover = useFluidHoverList({
    itemSelector: "[cmdk-item]",
    highlightedSelector: "[data-selected='true']",
  });
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      {...hover.containerProps}
      className={cn(
        "relative h-[min(360px,50vh)] scroll-py-2 overflow-x-hidden overflow-y-auto px-2 pt-0 pb-2 outline-hidden [&_[cmdk-group]+[cmdk-group]]:mt-1.5",
        className,
      )}
      {...props}
    >
      <FluidHoverHighlight {...hover.highlightProps} />
      {children}
    </CommandPrimitive.List>
  );
}

export function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-4 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-x-hidden pb-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A 36px row: a 16px icon, the label, then a shortcut or detail at the far end. */
export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm text-foreground outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-[selected=true]:[&_svg]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The keys that run a row's command anywhere else in the app, at the row's end. */
export function CommandShortcut({ keys }: { keys: readonly string[] }) {
  return (
    <span data-slot="command-shortcut" className="ms-auto flex shrink-0 items-center gap-1">
      {keys.map((key, i) => (
        <Keyboard key={`${key}-${i}`}>{key}</Keyboard>
      ))}
    </span>
  );
}

/** A row's secondary text (a thread's sender), at the row's end. */
export function CommandDetail({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-detail"
      className={cn("ms-auto max-w-2/5 min-w-0 shrink-0 truncate text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The key legend along the menu's foot, as transitive's has. */
export function CommandFooter({ hints }: { hints: { keys: string; label: string }[] }) {
  return (
    <div
      data-slot="command-footer"
      className="flex h-9 shrink-0 items-center gap-3 px-4 text-xs text-subtle-foreground"
    >
      {hints.map((hint, i) => (
        <span
          key={hint.label}
          className={cn("flex items-center gap-1.5", i === hints.length - 1 && "ms-auto")}
        >
          <Keyboard className="h-4 min-w-4 bg-hover text-[10px] text-subtle-foreground">
            {hint.keys}
          </Keyboard>
          {hint.label}
        </span>
      ))}
    </div>
  );
}
