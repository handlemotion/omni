import { Button } from "react-aria-components/Button";
import type { GridListItemProps, GridListProps } from "react-aria-components/GridList";
import {
  GridList as GridListPrimitive,
  GridListHeader as GridListHeaderPrimitive,
  GridListItem as GridListItemPrimitive,
  GridListSection as GridListSectionPrimitive,
} from "react-aria-components/GridList";
import { Text, type TextProps } from "react-aria-components/Text";
import { IconGrip } from "@/components/icons/central";
import { cn } from "cn";
import { cx } from "@/lib/primitive";
import { Checkbox, CheckboxField } from "./checkbox";

export function GridList<T extends object>({ className, ...props }: GridListProps<T>) {
  return (
    <GridListPrimitive
      data-slot="grid-list"
      className={cx("relative flex flex-col bg-background text-sm outline-hidden", className)}
      {...props}
    />
  );
}

export function GridListSection<T extends object>({
  className,
  ...props
}: React.ComponentProps<typeof GridListSectionPrimitive<T>>) {
  return (
    <GridListSectionPrimitive
      data-slot="grid-list-section"
      className={cn("divide-y", className)}
      {...props}
    />
  );
}

export function GridListHeader({
  className,
  ...props
}: React.ComponentProps<typeof GridListHeaderPrimitive>) {
  return (
    <GridListHeaderPrimitive
      data-slot="grid-list-header"
      className={cn("px-3 py-2.5 text-sm/6", className)}
      {...props}
    />
  );
}

export function GridListItem({ className, children, ...props }: GridListItemProps) {
  const textValue = typeof children === "string" ? children : undefined;
  return (
    <GridListItemPrimitive
      textValue={textValue}
      {...props}
      className={cx(
        "group relative flex min-w-0 cursor-default items-center outline-hidden focus-visible:inset-ring focus-visible:inset-ring-ring",
        "dragging:cursor-grab dragging:opacity-70 dragging:**:[[slot=drag]]:text-foreground",
        "href" in props && "cursor-pointer",
        className,
      )}
    >
      {(values) => (
        <>
          {values.allowsDragging && (
            // The whole item drags with a pointer; the handle is for the keyboard and screen
            // readers (an item with a link needs one), so it shows only while focused.
            <Button
              slot="drag"
              className="sr-only shrink-0 rounded-sm text-muted-foreground outline-hidden focus-visible:not-sr-only focus-visible:text-foreground"
            >
              <IconGrip data-slot="drag-icon" className="size-icon" />
            </Button>
          )}

          {values.selectionMode === "multiple" && values.selectionBehavior === "toggle" && (
            <CheckboxField className="gap-x-0" slot="selection">
              <Checkbox className="col-span-1" />
            </CheckboxField>
          )}
          {typeof children === "function" ? children(values) : children}
        </>
      )}
    </GridListItemPrimitive>
  );
}

export function GridListEmptyState({ ref, className, ...props }: React.ComponentProps<"div">) {
  return <div ref={ref} className={cn("p-6", className)} {...props} />;
}

export function GridListSpacer({ className, ref, ...props }: React.ComponentProps<"div">) {
  return <div ref={ref} aria-hidden className={cn("-ms-4 flex-1", className)} {...props} />;
}

export function GridListStart({ className, ref, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      ref={ref}
      className={cn("relative flex items-center gap-x-2.5 sm:gap-x-3", className)}
      {...props}
    />
  );
}

export interface GridListTextProps extends TextProps {
  ref?: React.Ref<HTMLDivElement>;
}

export function GridListLabel({ className, ref, ...props }: GridListTextProps) {
  return <Text ref={ref} className={cn("", className)} {...props} />;
}

export function GridListDescription({ className, ref, ...props }: GridListTextProps) {
  return (
    <Text
      slot="description"
      ref={ref}
      className={cn("font-normal text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export type { GridListItemProps, GridListProps };
