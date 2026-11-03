"use client";

import { CheckIcon, MinusIcon } from "@heroicons/react/20/solid";
import {
  CheckboxButton,
  type CheckboxButtonProps,
  CheckboxField as CheckboxFieldPrimitive,
  type CheckboxFieldProps,
} from "react-aria-components/Checkbox";
import {
  CheckboxGroup as CheckboxGroupPrimitive,
  type CheckboxGroupProps,
} from "react-aria-components/CheckboxGroup";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
import { cn } from "cn";
import { cx } from "@/lib/primitive";
import { Label } from "@/components/ui/field";

export function CheckboxGroup({ className, ...props }: CheckboxGroupProps) {
  return (
    <CheckboxGroupPrimitive
      {...props}
      data-slot="control"
      className={cx(
        "space-y-3 has-[[slot=description]]:not-has-[[slot=errorMessage]]:space-y-6 **:[[slot=description]]:block",
        className,
      )}
    />
  );
}

export function CheckboxField({ className, ...props }: CheckboxFieldProps) {
  return (
    <CheckboxFieldPrimitive
      data-slot="control"
      {...props}
      className={cx(
        "grid grid-cols-[--spacing(4.25)_1fr] gap-x-2 gap-y-1",
        "*:data-[slot=control]:col-start-1 *:data-[slot=control]:row-start-1 *:data-[slot=control]:mt-0.75 sm:*:data-[slot=control]:mt-1",
        "*:[[slot=errorMessage]]:col-span-full",
        "**:data-[slot=control-label]:col-start-2 **:data-[slot=control-label]:row-start-1",
        "*:[[slot=description]]:col-start-2 *:[[slot=description]]:row-start-2",
        "",
        className,
      )}
    />
  );
}

export function Checkbox({ className, ...props }: CheckboxButtonProps) {
  return (
    <CheckboxButton
      className={cx("group gap-x-3 inline-flex col-span-full focus:outline-hidden", className)}
      {...props}
    >
      {composeRenderProps(
        props.children,
        (children, { isSelected, isIndeterminate, isInvalid }) => {
          const indicator = isIndeterminate ? (
            <MinusIcon data-slot="check-indicator" />
          ) : isSelected ? (
            <CheckIcon data-slot="check-indicator" />
          ) : null;

          return (
            <div
              className={cn(
                "grid grid-cols-[--spacing(4.25)_1fr] items-center gap-y-1 has-data-[slot=control-label]:gap-x-2",
              )}
            >
              <span
                data-slot="indicator"
                className={cn([
                  "col-start-1 row-start-1 relative inset-ring inset-ring-input isolate flex shrink-0 items-center justify-center justify-self-center rounded-xs bg-(--control-bg,transparent) text-background group-focus-visible:inset-ring-ring",
                  "size-3.5 *:data-[slot=check-indicator]:size-3",
                  "in-disabled:bg-muted",
                  (isSelected || isIndeterminate) && [
                    "inset-ring-(--checkbox-ring,var(--color-ring)) bg-(--checkbox-bg,var(--color-primary)) text-(--checkbox-foreground,var(--color-primary-foreground))",
                    "group-invalid:inset-ring/70 group-invalid:bg-danger group-invalid:text-danger-foreground dark:group-invalid:inset-ring-danger-subtle-foreground/70",
                  ],
                  isInvalid &&
                    "inset-ring-danger-subtle-foreground/70 bg-danger-subtle/5 text-danger-foreground ring-danger-subtle-foreground/20 group-hover:inset-ring-danger-subtle-foreground/70",
                ])}
              >
                {indicator}
              </span>
              <Label
                className="col-start-2 row-start-1"
                data-slot="control-label"
                elementType="span"
              >
                {children}
              </Label>
            </div>
          );
        },
      )}
    </CheckboxButton>
  );
}
