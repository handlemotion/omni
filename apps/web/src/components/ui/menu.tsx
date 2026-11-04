import { CheckIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { Collection } from "react-aria-components/Collection";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
import { Header } from "react-aria-components/Header";
import type {
  MenuItemProps as MenuItemPrimitiveProps,
  MenuProps as MenuPrimitiveProps,
  MenuSectionProps as MenuSectionPrimitiveProps,
} from "react-aria-components/Menu";
import {
  Menu as MenuPrimitive,
  MenuItem as MenuItemPrimitive,
  MenuSection as MenuSectionPrimitive,
  MenuTrigger as MenuTriggerPrimitive,
  SubmenuTrigger,
} from "react-aria-components/Menu";
import { cn } from "cn";
import { tv, type VariantProps } from "tailwind-variants";
import { cx } from "@/lib/primitive";
import {
  DropdownDescription,
  dropdownItemStyles,
  DropdownKeyboard,
  DropdownLabel,
  dropdownSectionStyles,
  DropdownSeparator,
} from "./dropdown";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { FluidHoverHighlight } from "./fluid-hover-highlight";
import { Popover, type PopoverProps } from "./popover";

export const MenuTrigger = MenuTriggerPrimitive;
export const MenuSubMenu = SubmenuTrigger;

export interface MenuProps<T> extends MenuPrimitiveProps<T>, Pick<PopoverProps, "placement"> {
  className?: string;
  popover?: Pick<
    PopoverProps,
    | "arrow"
    | "className"
    | "placement"
    | "offset"
    | "crossOffset"
    | "arrowBoundaryOffset"
    | "triggerRef"
    | "isOpen"
    | "onOpenChange"
    | "shouldFlip"
    | "isNonModal"
    | "trigger"
    | "getTargetRect"
  >;
}

export const menuStyles = tv({
  // `minmax(0,1fr)`: the label column may shrink below its text, so a long label truncates
  // at the menu's max width instead of widening it.
  base: "grid max-h-[inherit] grid-cols-[auto_minmax(0,1fr)] gap-y-0 overflow-x-hidden overflow-y-auto overscroll-contain p-1 outline-hidden [&>[data-slot=menu-section]+[data-slot=menu-section]:not([class*='mt-']):not([class*='my-'])]:mt-3",
});

/** Every row React Aria renders in a menu, submenu triggers included. */
const MENU_ITEM_SELECTOR = "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']";

/**
 * The widest row sets the menu's width (fit-content): the longest label, then 36px to the edge
 * (the menu's 4px padding plus the row's 32px end padding); icons sit 12px in. Short menus keep a 132px floor so
 * they don't look pinched; past 240px labels truncate. Don't fix a menu's width; a menu whose
 * rows carry more (an avatar and two lines) raises only the cap with `max-w-*`.
 */
const MENU_WIDTH = "w-max min-w-33 max-w-60";

export function Menu<T extends object>({ className, placement, popover, ...props }: MenuProps<T>) {
  // One highlight springs between the rows (transitive's fluid hover). React Aria marks the row
  // it highlights (pointer or keys) with `data-focused`; an open submenu's trigger stays lit
  // while the pointer is in the submenu.
  const hover = useFluidHoverList({
    itemSelector: MENU_ITEM_SELECTOR,
    highlightedSelector: "[data-focused]",
    heldSelector: "[data-open]",
  });
  return (
    <Popover
      className={cx(MENU_WIDTH, "*:data-[slot=popover-inner]:overflow-hidden", popover?.className)}
      placement={placement}
      {...popover}
    >
      <div className="relative flex max-h-[inherit] min-h-0 flex-col" {...hover.containerProps}>
        <FluidHoverHighlight
          {...hover.highlightProps}
          className={
            hover.activeElement?.dataset.intent === "danger" ? "bg-danger-subtle" : "bg-accent"
          }
        />
        <MenuPrimitive data-slot="menu-content" className={menuStyles({ className })} {...props} />
      </div>
    </Popover>
  );
}

export interface MenuItemProps
  extends MenuItemPrimitiveProps, VariantProps<typeof dropdownItemStyles> {}

/** 32px after the label (36px to the menu's edge with its padding): see `MENU_WIDTH`. */
const ITEM_END = "pe-8";

export function MenuItem({ className, intent, children, ...props }: MenuItemProps) {
  const textValue = props.textValue || (typeof children === "string" ? children : undefined);
  return (
    <MenuItemPrimitive
      data-slot="menu-item"
      data-intent={intent}
      className={composeRenderProps(className, (className, { hasSubmenu, ...renderProps }) =>
        dropdownItemStyles({
          ...renderProps,
          intent,
          className: hasSubmenu
            ? cn(
                intent === "danger" && "open:bg-danger-subtle open:text-danger-subtle-foreground",
                intent === "warning" &&
                  "open:bg-warning-subtle open:text-warning-subtle-foreground",
                intent === undefined &&
                  "open:text-accent-foreground open:*:[.text-muted-foreground]:text-accent-foreground open:*:[svg]:text-accent-foreground",
                // The fluid hover highlight is the row's fill; the row paints none of its own.
                "bg-transparent focus:bg-transparent hover:bg-transparent",
                ITEM_END,
                className,
              )
            : cn("bg-transparent focus:bg-transparent hover:bg-transparent", ITEM_END, className),
        }),
      )}
      textValue={textValue}
      {...props}
    >
      {(values) => (
        <>
          {values.isSelected && ["single", "multiple"].includes(values.selectionMode) && (
            <CheckIcon />
          )}

          {typeof children === "function" ? (
            children(values)
          ) : typeof children === "string" ? (
            <MenuLabel>{children}</MenuLabel>
          ) : (
            children
          )}

          {values.hasSubmenu && (
            <ChevronRightIcon
              data-slot="chevron"
              className="absolute end-0 size-4 -translate-y-1/2"
              style={{
                top: "calc(var(--spacing) * 3)",
              }}
            />
          )}
        </>
      )}
    </MenuItemPrimitive>
  );
}

export interface MenuHeaderProps extends React.ComponentProps<typeof Header> {
  separator?: boolean;
}

export function MenuHeader({ className, separator = false, ...props }: MenuHeaderProps) {
  return (
    <Header
      className={cn(
        "col-span-full px-2.5 py-2 text-base sm:text-sm",
        separator && "-mx-1 border-b sm:px-3 sm:pb-2.5",
        className,
      )}
      {...props}
    />
  );
}

const { section, header } = dropdownSectionStyles();

export interface MenuSectionProps<T> extends MenuSectionPrimitiveProps<T> {
  ref?: React.Ref<HTMLDivElement>;
  label?: string;
  /** Spacing and alignment for the label, which belongs to the rows below it. */
  labelClassName?: string;
}

export function MenuSection<T extends object>({
  className,
  labelClassName,
  children,
  ref,
  ...props
}: MenuSectionProps<T>) {
  return (
    <MenuSectionPrimitive
      data-slot="menu-section"
      ref={ref}
      className={section({ className })}
      {...props}
    >
      {"label" in props && (
        <Header className={header({ className: labelClassName })}>{props.label}</Header>
      )}
      <Collection items={props.items}>{children}</Collection>
    </MenuSectionPrimitive>
  );
}

/** Runs edge to edge: `-mx-1` cancels the menu's 4px padding (`menuStyles`). */
export function MenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownSeparator>) {
  return <DropdownSeparator className={cn("-mx-1", className)} {...props} />;
}
export const MenuShortcut = DropdownKeyboard;
/** A row's label: one line, truncated once the menu reaches its max width. */
export function MenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownLabel>) {
  return <DropdownLabel className={cn("truncate", className)} {...props} />;
}
export const MenuDescription = DropdownDescription;
