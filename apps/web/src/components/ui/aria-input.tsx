import { Group, type GroupProps } from "react-aria-components/Group";
import { Input as InputPrimitive, type InputProps } from "react-aria-components/Input";
import { cx } from "@/lib/primitive";
import { inputClassName, inputGroupClassName } from "./input";

export interface AriaInputProps extends Omit<InputProps, "size"> {
  ref?: React.Ref<HTMLInputElement>;
  size?: "sm" | "md" | "lg";
  plain?: boolean;
}

export function AriaInput({
  className,
  ref,
  size = "md",
  plain = false,
  ...props
}: AriaInputProps) {
  return (
    <span data-slot="control" className="relative block w-full">
      <InputPrimitive
        ref={ref}
        {...props}
        className={cx(inputClassName({ size, plain, invalid: "aria" }), className)}
      />
    </span>
  );
}

export function AriaInputGroup({ className, ...props }: GroupProps) {
  return <Group data-slot="control" {...props} className={cx(inputGroupClassName, className)} />;
}
