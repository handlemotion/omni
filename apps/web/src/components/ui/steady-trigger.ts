import { useRef } from "react";

const CLOSE_FALLBACK_MS = 250;

/**
 * Keeps an open popup where it opened. A popup sits against its trigger and is at least as wide,
 * so a trigger that changes width while the popup is up (a label naming the choice, a count) slides
 * the popup and its rows sideways under the pointer. The trigger keeps its width from opening until
 * the popup has finished closing, and `afterClose` holds a change until then.
 */
export function useSteadyTrigger() {
  const ref = useRef<HTMLElement>(null);
  const pending = useRef<(() => void)[]>([]);
  const flush = () => {
    const run = pending.current;
    pending.current = [];
    for (const each of run) each();
  };
  return {
    ref,
    onOpenChange(open: boolean) {
      const trigger = ref.current;
      if (open && trigger) trigger.style.minWidth = `${trigger.getBoundingClientRect().width}px`;
    },
    onOpenChangeComplete(open: boolean) {
      if (open) return;
      flush();
      if (ref.current) ref.current.style.minWidth = "";
    },
    afterClose(change: () => void) {
      pending.current.push(change);
      setTimeout(flush, CLOSE_FALLBACK_MS);
    },
  };
}
