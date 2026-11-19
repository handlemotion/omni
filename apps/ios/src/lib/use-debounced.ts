import { useEffect, useState } from "react";

/** `value`, once it has held still for `ms`: a search runs on a pause, not on every keystroke. */
export function useDebounced<T>(value: T, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
