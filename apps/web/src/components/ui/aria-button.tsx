// React Aria's button, kept only for the React Aria components not yet moved to UI SDK
// (select, combo box, date picker, file trigger, dialog close...). Their trigger and slot
// wiring needs a React Aria pressable; everything else uses `Button` from ./button.
import {
  Button as ButtonPrimitive,
  type ButtonProps as ButtonPrimitiveProps,
} from "react-aria-components/Button";
import { type VariantProps } from "tailwind-variants";
import { cx } from "@/lib/primitive";
import { buttonStyles, Pending } from "./button";

export interface AriaButtonProps extends ButtonPrimitiveProps, VariantProps<typeof buttonStyles> {
  ref?: React.Ref<HTMLButtonElement>;
}

export function AriaButton({
  className,
  intent,
  size,
  isCircle,
  ref,
  children,
  ...props
}: AriaButtonProps) {
  return (
    <ButtonPrimitive
      ref={ref}
      data-inset={size === "inset" || undefined}
      {...props}
      className={cx(buttonStyles({ intent, size, isCircle }), className)}
    >
      {(values) => {
        const content = typeof children === "function" ? children(values) : children;
        return values.isPending ? <Pending>{content}</Pending> : content;
      }}
    </ButtonPrimitive>
  );
}
