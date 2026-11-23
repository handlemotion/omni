import { useEffect, useRef, useState } from "react";
import { appToast } from "@/components/ui/toast";

/** How long a copy button shows it copied. */
export const COPIED_MS = 2000;

/** Copies `text`; when the browser refuses, toasts "`what` was not copied". True once copied. */
export async function copyText(text: string, what = "Text") {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    appToast.error(`${what} was not copied`);
    return false;
  }
}

/** `copy(text)` through `copyText`, with `copied` true for `COPIED_MS` after it lands. */
export function useClipboard(what?: string) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const copy = async (value: string) => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    if (!(await copyText(value, what))) {
      setCopied(false);
      return false;
    }
    setCopied(true);
    timeoutRef.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    return true;
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, []);

  return { copy, copied };
}
