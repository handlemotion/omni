// A list page's search box (the CRM's lists, Drive's Search): its text, kept in the URL's `q`.
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useDebouncedValue } from "./use-debounced-value.ts";

/**
 * The search box's text, written to the URL's `q` once typing pauses, so the list it filters can
 * be linked and survives a reload.
 */
export function useListSearch(q: string) {
  const navigate = useNavigate();
  const [text, setText] = useState(q);
  const settled = useDebouncedValue(text.trim(), 250);
  useEffect(() => {
    if (settled === q) return;
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, q: settled || undefined }),
      replace: true,
    });
    // Only a new settled text writes the URL; the URL changing (back, a link) leaves the box.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  return { text, setText };
}
