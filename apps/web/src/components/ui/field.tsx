import {
  FieldDescription,
  FieldError as FieldErrorPrimitive,
  FieldLabel,
  useFieldControl,
} from "@ui-sdk/react/field";
import {
  FieldError as AriaFieldError,
  type FieldErrorProps,
} from "react-aria-components/FieldError";
import { Label as AriaLabel, LabelContext, type LabelProps } from "react-aria-components/Label";
import { Text, type TextProps } from "react-aria-components/Text";
import { cn } from "cn";
import { tv } from "tailwind-variants";
import { cx } from "@/lib/primitive";

export const labelStyles = tv({
  base: [
    // Required is the default; optional fields say "(Optional)" instead of required ones getting a *.
    "select-none text-sm text-muted-foreground",
    "in-disabled:pointer-events-none in-disabled:opacity-50 group-disabled:opacity-50 data-disabled:opacity-50",
  ],
});

export const descriptionStyles = tv({
  base: "block text-muted-foreground text-sm/6 in-disabled:opacity-50 group-disabled:opacity-50",
});

export const fieldErrorStyles = tv({
  base: "block text-danger-subtle-foreground text-sm/6 in-disabled:opacity-50 group-disabled:opacity-50 forced-colors:text-[Mark]",
});

/** Spacing between a field's parts, for UI SDK's `field-*` slots and React Aria's. */
export const fieldStyles = tv({
  base: [
    "w-full",
    // UI SDK: label, then control (or description), description, error.
    "[&>[data-slot=field-label]+*]:mt-1.5",
    "[&>[data-slot=field-label]+[data-slot=field-description]]:mt-1",
    "[&>[data-slot=field-description]+*]:mt-2",
    "[&>*+[data-slot=field-description]]:mt-2 [&>*+[data-slot=field-error]]:mt-2",
    // React Aria hosts (combo box, number field, select) until they move.
    "[&>[data-slot=control]+[data-slot=control]]:mt-2",
    "[&>[data-slot=label]+[data-slot=control]]:mt-1.5",
    "[&>[data-slot=label]+[slot='description']]:mt-1",
    "[&>[slot=description]+[data-slot=control]]:mt-2",
    "[&>[data-slot=control]+[slot=description]]:mt-2",
    "[&>[data-slot=control]+[slot=errorMessage]]:mt-2",
    "in-disabled:opacity-50 disabled:opacity-50 data-disabled:opacity-50",
  ],
});

/**
 * Inside a `TextField` (UI SDK's Field) it is the field's label. Elsewhere it is React Aria's,
 * which still labels the React Aria hosts (select, combo box, number field, checkbox) and is a
 * plain `<label>` outside them.
 */
export function Label({ className, htmlFor, slot, elementType, ...props }: LabelProps) {
  const field = useFieldControl();
  if (field) {
    return (
      <FieldLabel id={props.id} className={labelStyles({ className })} children={props.children} />
    );
  }

  const label = (
    <AriaLabel
      data-slot="label"
      htmlFor={htmlFor}
      slot={slot}
      elementType={elementType}
      {...props}
      className={labelStyles({ className })}
    />
  );

  if (htmlFor && slot === undefined) {
    return <LabelContext.Provider value={null}>{label}</LabelContext.Provider>;
  }

  return label;
}

export function Description({ className, ...props }: TextProps) {
  const field = useFieldControl();
  if (field) {
    return (
      <FieldDescription className={descriptionStyles({ className })} children={props.children} />
    );
  }
  return <Text {...props} slot="description" className={descriptionStyles({ className })} />;
}

/**
 * Inside a `TextField`, shows while the field is invalid: after a submit, until the value changes.
 * Without children it shows the browser's message.
 */
export function FieldError({ className, ...props }: FieldErrorProps) {
  const field = useFieldControl();
  if (field) {
    return (
      <FieldErrorPrimitive
        className={fieldErrorStyles({ className: typeof className === "string" ? className : "" })}
        children={typeof props.children === "function" ? undefined : props.children}
      />
    );
  }
  return <AriaFieldError {...props} className={cx(fieldErrorStyles(), className)} />;
}

export function Fieldset({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      className={cn("*:data-[slot=text]:mt-1 [&>*+[data-slot=control]]:mt-6", className)}
      {...props}
    />
  );
}

export function FieldGroup({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div data-slot="control" className={cn("space-y-6", className)} {...props} />;
}

export function Legend({ className, ...props }: React.ComponentProps<"legend">) {
  return (
    <legend
      data-slot="legend"
      {...props}
      className={cn("text-base/6 data-disabled:opacity-50", className)}
    />
  );
}
