"use client";

import { CheckIcon, ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { Field } from "@ui-sdk/react/field";
import {
  Select as SelectPrimitive,
  SelectContent as SelectContentPrimitive,
  SelectItem as SelectItemPrimitive,
  SelectItemIndicator,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue,
} from "@ui-sdk/react/select";
import {
  Children,
  createContext,
  isValidElement,
  use,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn, twJoin } from "cn";
import { dropdownItemStyles, ItemLabel } from "./dropdown";
import { fieldStyles } from "./field";
import { toSideAlign, type Placement } from "./placement";
import { popupSurface } from "./popover";

type Key = string | number;

/** What the trigger needs from the root: its name and id when there's no visible label. */
const SelectTriggerContext = createContext<{ "aria-label"?: string; id?: string }>({});

export interface SelectProps {
  value?: Key | null;
  defaultValue?: Key | null;
  onChange?: (value: string | null) => void;
  placeholder?: string;
  isDisabled?: boolean;
  isRequired?: boolean;
  name?: string;
  "aria-label"?: string;
  /** The trigger's id, for a label elsewhere that points at it. */
  id?: string;
  className?: string;
  /** A `Label`, a `SelectTrigger` and a `SelectContent`. */
  children?: ReactNode;
}

/**
 * React Aria's `Select` shape on UI SDK's select: `<Select value onChange><Label/><SelectTrigger/>
 * <SelectContent items>{(item) => <SelectItem id textValue/>}</SelectContent></Select>`. It sits
 * in a UI SDK Field, so the `Label` inside names the trigger.
 */
export function Select({
  value,
  defaultValue,
  onChange,
  placeholder,
  isDisabled,
  isRequired,
  name,
  "aria-label": ariaLabel,
  id,
  className,
  children,
}: SelectProps) {
  return (
    <Field disabled={isDisabled} className={cn(fieldStyles(), className)}>
      <SelectPrimitive<string>
        items={itemsOf(children)}
        value={value === undefined ? undefined : value === null ? null : String(value)}
        defaultValue={
          defaultValue === undefined
            ? undefined
            : defaultValue === null
              ? null
              : String(defaultValue)
        }
        onValueChange={onChange && ((next) => onChange(next))}
        placeholder={placeholder}
        required={isRequired}
        name={name}
      >
        <SelectTriggerContext value={{ "aria-label": ariaLabel, id }}>
          {children}
        </SelectTriggerContext>
      </SelectPrimitive>
    </Field>
  );
}

/**
 * The items' values and labels, read from the `SelectContent` child, so the trigger can show the
 * chosen label before the list has ever opened.
 */
function itemsOf(children: ReactNode) {
  const content = Children.toArray(children).find(
    (child): child is ReactElement<SelectContentProps<object>> =>
      isValidElement(child) && child.type === SelectContent,
  );
  if (!content?.props.items || typeof content.props.children !== "function") return undefined;
  const render = content.props.children;
  return [...content.props.items].flatMap((item) => {
    const row = render(item);
    if (!isValidElement<SelectItemProps>(row) || row.props.id === undefined) return [];
    const label =
      row.props.textValue ?? (typeof row.props.children === "string" ? row.props.children : "");
    return [{ value: String(row.props.id), label, disabled: row.props.isDisabled }];
  });
}

export interface SelectTriggerProps {
  prefix?: ReactNode;
  className?: string;
  /** Replaces the chosen value and chevron. */
  children?: ReactNode;
}

/** The `md` control size, like `Input` and `Button`: 32px tall, 8px in. */
export function SelectTrigger({ children, className, prefix }: SelectTriggerProps) {
  const own = use(SelectTriggerContext);
  return (
    <SelectTriggerPrimitive
      {...own}
      className={cn(
        "group/select-trigger flex h-8 w-full min-w-0 cursor-default items-center gap-x-2 rounded-lg border border-input bg-(--control-bg,var(--color-background)) px-2 text-start text-sm text-foreground outline-hidden dark:shadow-none",
        "focus-visible:border-ring/70 enabled:hover:border-muted-foreground/30 data-open:border-ring/70",
        "data-invalid:border-danger-subtle-foreground/70",
        "disabled:bg-muted disabled:opacity-50 forced-colors:disabled:border-[GrayText] forced-colors:disabled:text-[GrayText]",
        "dark:scheme-dark",
        className,
      )}
    >
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      {children ?? (
        <>
          <SelectValue
            className={twJoin(
              "truncate text-start data-placeholder:text-muted-foreground sm:text-sm/6",
              "*:[svg]:size-5 sm:*:[svg]:size-4",
            )}
          />
          <ChevronUpDownIcon
            data-slot="chevron"
            aria-hidden
            className="ms-auto -me-1 size-5 shrink-0 text-muted-foreground sm:size-4"
          />
        </>
      )}
    </SelectTriggerPrimitive>
  );
}

export interface SelectContentProps<T extends object> {
  items?: Iterable<T>;
  /** One `SelectItem` per item. */
  children: ((item: T) => ReactNode) | ReactNode;
  popover?: { placement?: Placement; className?: string };
  className?: string;
}

export function SelectContent<T extends object>({
  items,
  children,
  popover,
  className,
}: SelectContentProps<T>) {
  const { side, align } = toSideAlign(popover?.placement ?? "bottom");
  return (
    <SelectContentPrimitive
      side={side}
      align={align}
      sideOffset={4}
      className={cn(
        popupSurface,
        "grid w-max max-w-80 min-w-(--anchor-width) grid-cols-[auto_1fr] gap-y-1 overflow-y-auto p-1",
        popover?.className,
        className,
      )}
    >
      {typeof children === "function"
        ? items &&
          [...items].map((item, i) => <ItemKey key={keyOf(item, i)}>{children(item)}</ItemKey>)
        : children}
    </SelectContentPrimitive>
  );
}

function keyOf(item: object, index: number) {
  const record = item as { id?: Key; value?: Key };
  return (record.id ?? record.value ?? index) satisfies Key;
}

function ItemKey({ children }: { children: ReactNode }) {
  return children;
}

export interface SelectItemProps {
  id?: Key;
  textValue?: string;
  isDisabled?: boolean;
  className?: string;
  children?: ReactNode;
}

export function SelectItem({ id, textValue, isDisabled, className, children }: SelectItemProps) {
  return (
    <SelectItemPrimitive<string>
      value={String(id ?? textValue ?? "")}
      label={textValue}
      disabled={isDisabled}
      className={(state) =>
        dropdownItemStyles({
          isFocused: state.highlighted,
          isDisabled: state.disabled,
          isSelected: state.selected,
          className,
        })
      }
    >
      {typeof children === "string" ? <ItemLabel>{children}</ItemLabel> : children}
      <SelectItemIndicator
        render={
          <CheckIcon
            data-slot="check-indicator"
            className="absolute end-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground"
          />
        }
      />
    </SelectItemPrimitive>
  );
}
