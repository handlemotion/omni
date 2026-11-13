"use client";

import { Field } from "@ui-sdk/react/field";
import { createContext, use, type ReactNode } from "react";
import { cn } from "cn";
import { fieldStyles } from "./field";

/** What a `TextField` hands the `Input` inside it: the value and the native input attributes. */
export interface TextFieldInputProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  type?: React.HTMLInputTypeAttribute;
  name?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  required?: boolean;
  readOnly?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  "aria-label"?: string;
}

export const TextFieldContext = createContext<TextFieldInputProps | null>(null);

/** The props a `TextField` passed down, for the `Input` (or `Textarea`) inside it. */
export function useTextField() {
  return use(TextFieldContext);
}

export interface TextFieldProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  type?: React.HTMLInputTypeAttribute;
  name?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  isRequired?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  /** Shows the field as invalid now; leave it out to use the browser's validation. */
  isInvalid?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  "aria-label"?: string;
  className?: string;
  ref?: React.Ref<HTMLDivElement>;
  /** A `Label`, an `Input` (or an `InputGroup` holding one), a `Description`, a `FieldError`. */
  children?: ReactNode;
}

/**
 * React Aria's `TextField` shape on UI SDK's Field: the label, description and errors are wired to
 * the `Input` inside. Invalid shows after a submit and clears as soon as the value changes, so a
 * person who fixes a typo doesn't keep seeing red while they type.
 */
export function TextField({
  value,
  defaultValue,
  onChange,
  type,
  name,
  autoComplete,
  autoFocus,
  isRequired,
  isDisabled,
  isReadOnly,
  isInvalid,
  maxLength,
  minLength,
  pattern,
  inputMode,
  "aria-label": ariaLabel,
  className,
  ref,
  children,
}: TextFieldProps) {
  return (
    <Field
      ref={ref}
      name={name}
      disabled={isDisabled}
      invalid={isInvalid}
      className={cn(fieldStyles(), className)}
    >
      <TextFieldContext
        value={{
          value,
          defaultValue,
          onValueChange: onChange,
          type,
          autoComplete,
          autoFocus,
          required: isRequired,
          readOnly: isReadOnly,
          maxLength,
          minLength,
          pattern,
          inputMode,
          "aria-label": ariaLabel,
        }}
      >
        {children}
      </TextFieldContext>
    </Field>
  );
}
