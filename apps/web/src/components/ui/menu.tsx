import { CheckIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import {
  Menu as MenuRoot,
  MenuCheckboxItem,
  MenuContent,
  MenuContextTrigger,
  MenuGroup,
  MenuGroupLabel,
  MenuItem as MenuItemPrimitive,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuSeparatorPrimitive,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger as MenuTriggerPrimitive,
} from "@ui-sdk/react/menu";
import { cn } from "cn";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useRef,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { tv, type VariantProps } from "tailwind-variants";
import {
  dropdownItemStyles,
  DropdownKeyboard,
  dropdownSectionStyles,
  ItemDescription,
  ItemLabel,
} from "./dropdown";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { FluidHoverHighlight } from "./fluid-hover-highlight";
import { toSideAlign, type Placement } from "./placement";
import { popupSurface } from "./popover";

// Menus on UI SDK's menu, keeping React Aria's shape so call sites read the same:
//   <MenuTrigger><Button/><Menu onAction selectionMode selectedKeys>{items}</Menu></MenuTrigger>
// Plain items are `menuitem`s; `selectionMode="single"` makes them `menuitemradio`s in one group,
// `"multiple"` makes them `menuitemcheckbox`es that keep the menu open.

type Key = string;

interface MenuState {
  selectionMode: "none" | "single" | "multiple";
  selected: Set<Key>;
  onAction?: (key: Key) => void;
  onSelectionChange?: (keys: Set<Key>) => void;
  /** Per-item `onAction`s, for radio items, which UI SDK reports through their group. */
  actions: Map<Key, () => void>;
}

const MenuStateContext = createContext<MenuState>({
  selectionMode: "none",
  selected: new Set(),
  actions: new Map(),
});
/** Inside a `MenuSubMenu`, a `<Menu>` is that submenu's content. */
const SubmenuContext = createContext(false);

export interface MenuTriggerProps {
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The trigger element first, then its `<Menu>`. */
  children: ReactNode;
}

/**
 * The first child becomes the trigger through `render`, so it must forward its props and ref to
 * its DOM element (our `Button` and `TooltipTrigger` do).
 */
export function MenuTrigger({ isOpen, defaultOpen, onOpenChange, children }: MenuTriggerProps) {
  const [trigger, ...rest] = Children.toArray(children);
  return (
    <MenuRoot
      open={isOpen}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange && ((open) => onOpenChange(open))}
    >
      <MenuTriggerPrimitive render={trigger as ReactElement<Record<string, unknown>>} />
      {rest}
    </MenuRoot>
  );
}

export interface ContextMenuTriggerProps {
  onOpenChange?: (open: boolean) => void;
  /** The area first, then its `<Menu>`. */
  children: ReactNode;
}

/**
 * A menu opened at the pointer by a right-click or a long press on its area (Shift+F10 from the
 * keys). The first child becomes the area through `render`, so it must forward its props and ref
 * to its DOM element; a `contextmenu` event it stops in the capture phase leaves the browser's
 * own menu, for the parts of the area that have no actions.
 */
export function ContextMenuTrigger({ onOpenChange, children }: ContextMenuTriggerProps) {
  const [area, ...rest] = Children.toArray(children);
  return (
    <MenuRoot onOpenChange={onOpenChange && ((open) => onOpenChange(open))}>
      <MenuContextTrigger render={area as ReactElement<Record<string, unknown>>} />
      {rest}
    </MenuRoot>
  );
}

export interface MenuProps<T> {
  placement?: Placement;
  popover?: {
    className?: string;
    offset?: number;
    placement?: Placement;
    /** Room kept from the window's edges (16px). Less for a trigger that sits closer. */
    collisionPadding?: number;
    /** What the menu lines up with and takes `--anchor-width` from, in place of its trigger. */
    anchor?: ComponentProps<typeof MenuContent>["anchor"];
    /** Where the menu is placed in the page, in place of beside its trigger (`document.body`). */
    container?: ComponentProps<typeof MenuContent>["container"];
  };
  className?: string;
  "aria-label"?: string;
  /** With a function as children, renders one item per entry (keyed by its `id`). */
  items?: Iterable<T>;
  children?: ReactNode | ((item: T) => ReactNode);
  onAction?: (key: Key) => void;
  selectionMode?: "none" | "single" | "multiple";
  selectedKeys?: Iterable<Key>;
  onSelectionChange?: (keys: Set<Key>) => void;
  /** Shown in place of the items when there are none. */
  renderEmptyState?: () => ReactNode;
}

export const menuStyles = tv({
  // `minmax(0,1fr)`: the label column may shrink below its text, so a long label truncates
  // at the menu's max width instead of widening it.
  base: "grid max-h-[inherit] grid-cols-[auto_minmax(0,1fr)] gap-y-0 overflow-x-hidden overflow-y-auto overscroll-contain p-1 outline-hidden [&>[data-slot=menu-section]+[data-slot=menu-section]:not([class*='mt-']):not([class*='my-'])]:mt-3",
});

/** Every row a menu renders, submenu triggers included. */
const MENU_ITEM_SELECTOR = "[role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox']";

/**
 * The widest row sets the menu's width (fit-content): the longest label, then 36px to the edge
 * (the menu's 4px padding plus the row's 32px end padding); icons sit 12px in. Short menus keep a 132px floor so
 * they don't look pinched; past 240px labels truncate. Don't fix a menu's width; a menu whose
 * rows carry more (an avatar and two lines) raises only the cap with `max-w-*`.
 */
const MENU_WIDTH = "w-max min-w-33 max-w-60";

/** Where the menu opens: beside its trigger (a submenu places itself), 8px off, 16px from edges. */
function positionProps(
  nested: boolean,
  popover: MenuProps<object>["popover"],
  placement: Placement | undefined,
) {
  return {
    ...(nested ? {} : toSideAlign(popover?.placement ?? placement ?? "bottom start")),
    sideOffset: popover?.offset ?? 8,
    collisionPadding: popover?.collisionPadding ?? 16,
    ...(popover?.anchor ? { anchor: popover.anchor } : {}),
    ...(popover?.container ? { container: popover.container } : {}),
  };
}

/** A group around items that keeps them on the menu's grid. */
const ON_GRID = "col-span-full grid grid-cols-subgrid";

export function Menu<T extends { id?: Key }>({
  className,
  placement,
  popover,
  items,
  children,
  onAction,
  selectionMode = "none",
  selectedKeys,
  onSelectionChange,
  renderEmptyState,
  ...props
}: MenuProps<T>) {
  const nested = useContext(SubmenuContext);
  const actions = useRef(new Map<Key, () => void>()).current;
  const selected = new Set(selectedKeys ?? []);
  // One highlight springs between the rows (transitive's fluid hover). UI SDK marks the row it
  // highlights (pointer or keys) with `data-highlighted`; an open submenu's trigger stays lit
  // while the pointer is in the submenu.
  const hover = useFluidHoverList({
    itemSelector: MENU_ITEM_SELECTOR,
    highlightedSelector: "[data-highlighted]",
    heldSelector: "[data-open]",
  });
  const rows =
    typeof children === "function"
      ? [...(items ?? [])].map((item, i) => (
          <MenuKey key={item.id ?? i}>{(children as (item: T) => ReactNode)(item)}</MenuKey>
        ))
      : children;
  const empty = Children.count(rows) === 0;
  const Content = nested ? MenuSubContent : MenuContent;
  return (
    <MenuStateContext.Provider
      value={{ selectionMode, selected, onAction, onSelectionChange, actions }}
    >
      <Content
        {...positionProps(nested, popover, placement)}
        className={cn(MENU_WIDTH, popupSurface, "overflow-hidden", popover?.className)}
        aria-label={props["aria-label"]}
      >
        <div className="relative flex max-h-[inherit] min-h-0 flex-col" {...hover.containerProps}>
          <FluidHoverHighlight
            {...hover.highlightProps}
            className={
              hover.activeElement?.dataset.intent === "danger" ? "bg-danger-subtle" : "bg-accent"
            }
          />
          <div data-slot="menu-list" className={menuStyles({ className })}>
            {empty && renderEmptyState ? (
              <div className="col-span-full">{renderEmptyState()}</div>
            ) : selectionMode === "single" ? (
              <MenuRadioGroup
                className={ON_GRID}
                value={[...selected][0] ?? null}
                onValueChange={(key) => {
                  onSelectionChange?.(new Set([key]));
                  actions.get(key)?.();
                }}
              >
                {rows}
              </MenuRadioGroup>
            ) : (
              rows
            )}
          </div>
        </div>
      </Content>
    </MenuStateContext.Provider>
  );
}

function MenuKey({ children }: { children: ReactNode }) {
  return children;
}

export interface MenuItemProps extends VariantProps<typeof dropdownItemStyles> {
  /** Identifies the item to the menu's `onAction` and selection. */
  id?: Key;
  /** The text typeahead matches, when the content isn't plain text. */
  textValue?: string;
  onAction?: () => void;
  isDisabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/** 32px after the label (36px to the menu's edge with its padding): see `MENU_WIDTH`. */
const ITEM_END = "pe-8";

export function MenuItem({
  className,
  intent,
  children,
  id,
  textValue,
  onAction,
  isDisabled,
}: MenuItemProps) {
  const menu = useContext(MenuStateContext);
  const key = id ?? textValue ?? "";
  const label = textValue || (typeof children === "string" ? children : undefined);
  const content = (
    <>
      {typeof children === "string" ? <MenuLabel>{children}</MenuLabel> : children}
      {menu.selectionMode !== "none" && (
        // At the row's end, inside its 32px end padding, centred on the first line.
        <MenuItemIndicator
          render={
            <CheckIcon
              data-slot="check-indicator"
              className="absolute end-2.5 top-3.75 size-3.5 -translate-y-1/2 text-foreground"
            />
          }
        />
      )}
    </>
  );
  const shared = {
    label,
    disabled: isDisabled,
    "data-intent": intent,
    // The fluid hover highlight is the row's fill; the row paints none of its own.
    className: (state: { highlighted: boolean; disabled: boolean; checked?: boolean }) =>
      dropdownItemStyles({
        intent,
        isFocused: state.highlighted,
        isDisabled: state.disabled,
        isSelected: state.checked,
        className: cn(
          "bg-transparent focus:bg-transparent hover:bg-transparent",
          ITEM_END,
          className,
        ),
      }),
  };

  if (menu.selectionMode === "single") {
    if (onAction) menu.actions.set(key, onAction);
    else menu.actions.set(key, () => menu.onAction?.(key));
    return (
      <MenuRadioItem value={key} closeOnSelect {...shared}>
        {content}
      </MenuRadioItem>
    );
  }
  if (menu.selectionMode === "multiple") {
    return (
      <MenuCheckboxItem
        value={key}
        checked={menu.selected.has(key)}
        closeOnSelect={false}
        onCheckedChange={(checked) => {
          const next = new Set(menu.selected);
          if (checked) next.add(key);
          else next.delete(key);
          menu.onSelectionChange?.(next);
          onAction?.();
        }}
        {...shared}
      >
        {content}
      </MenuCheckboxItem>
    );
  }
  return (
    <MenuItemPrimitive
      value={key}
      destructive={intent === "danger"}
      onSelect={() => {
        onAction?.();
        menu.onAction?.(key);
      }}
      {...shared}
    >
      {content}
    </MenuItemPrimitive>
  );
}

export interface MenuSubMenuProps {
  /** A `MenuItem` (the row that opens it) first, then its `<Menu>`. */
  children: ReactNode;
  delay?: number;
}

export function MenuSubMenu({ children, delay }: MenuSubMenuProps) {
  const [item, ...rest] = Children.toArray(children);
  const row = isValidElement<MenuItemProps>(item) ? item.props : {};
  return (
    <MenuSub delay={delay}>
      <MenuSubTrigger
        disabled={row.isDisabled}
        className={dropdownItemStyles({
          intent: row.intent,
          className: cn(
            "bg-transparent focus:bg-transparent hover:bg-transparent",
            "data-open:text-accent-foreground data-open:*:[.text-muted-foreground]:text-accent-foreground data-open:*:[svg]:text-accent-foreground",
            ITEM_END,
            row.className,
          ),
        })}
      >
        {row.children}
        <ChevronRightIcon
          data-slot="chevron"
          aria-hidden
          className="absolute end-0 size-4 -translate-y-1/2"
          style={{ top: "calc(var(--spacing) * 3)" }}
        />
      </MenuSubTrigger>
      <SubmenuContext.Provider value={true}>{rest}</SubmenuContext.Provider>
    </MenuSub>
  );
}

export interface MenuHeaderProps extends React.ComponentProps<"div"> {
  separator?: boolean;
}

export function MenuHeader({ className, separator = false, ...props }: MenuHeaderProps) {
  return (
    <div
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

export interface MenuSectionProps {
  label?: string;
  /** Spacing and alignment for the label, which belongs to the rows below it. */
  labelClassName?: string;
  className?: string;
  children?: ReactNode;
}

export function MenuSection({ className, labelClassName, label, children }: MenuSectionProps) {
  return (
    <MenuGroup data-slot="menu-section" className={section({ className })}>
      {label && (
        <MenuGroupLabel className={header({ className: labelClassName })}>{label}</MenuGroupLabel>
      )}
      {children}
    </MenuGroup>
  );
}

/** Runs edge to edge: `-mx-1` cancels the menu's 4px padding (`menuStyles`). */
export function MenuSeparator({ className }: { className?: string }) {
  return (
    <MenuSeparatorPrimitive className={cn("col-span-full -mx-1 my-1 h-px bg-border", className)} />
  );
}
export const MenuShortcut = DropdownKeyboard;
/** A row's label: one line, truncated once the menu reaches its max width. */
export function MenuLabel({ className, ...props }: React.ComponentProps<typeof ItemLabel>) {
  return <ItemLabel className={cn("truncate", className)} {...props} />;
}
export const MenuDescription = ItemDescription;
