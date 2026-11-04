"use client";

import { useEffect, useRef, useState } from "react";
import {
  TextField as TextFieldPrimitive,
  type TextFieldProps,
} from "react-aria-components/TextField";
import { cx } from "@/lib/primitive";
import { fieldStyles } from "./field";

/**
 * Invalid shows after a submit and clears as soon as the value changes. React Aria's native
 * validation keeps the error up until the field is committed (blur), so a person who fixes a
 * typo would keep seeing red while they type. Editing hides it until the next submit, where
 * the browser's `invalid` event shows it again. An `isInvalid` from the caller always wins.
 */
export function TextField({
  className,
  isInvalid,
  onChange,
  ref,
  ...props
}: TextFieldProps & { ref?: React.Ref<HTMLDivElement> }) {
  const own = useRef<HTMLDivElement>(null);
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    const field = own.current;
    if (!field) return;
    // `invalid` does not bubble; a capture listener on the field still hears its input's.
    const shown = () => setEdited(false);
    field.addEventListener("invalid", shown, true);
    return () => field.removeEventListener("invalid", shown, true);
  }, []);

  return (
    <TextFieldPrimitive
      data-slot="control"
      ref={(node) => {
        own.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      isInvalid={isInvalid ?? (edited ? false : undefined)}
      onChange={(value) => {
        setEdited(true);
        onChange?.(value);
      }}
      className={cx(fieldStyles(), className)}
      {...props}
    />
  );
}
