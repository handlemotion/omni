import { useCallback, useMemo, useState } from "react";
import { addDays, startOfWeek } from "@/lib/calendar-grid.ts";

const AROUND = 4;

/** A month as one number (year × 12 + month), so months compare and step by addition. */
export const monthOf = (date: Date) => date.getFullYear() * 12 + date.getMonth();
export const firstOf = (month: number) => new Date(Math.floor(month / 12), month % 12, 1);

/**
 * The months the month view has laid out as one long page of weeks: a few around the shown month,
 * growing at either end as it scrolls there, and laid out afresh when the shown month jumps far.
 */
export function useMonthSpan(anchor: Date) {
  const at = monthOf(anchor);
  const [span, setSpan] = useState({ first: at - AROUND, last: at + AROUND });
  if (at < span.first || at > span.last) {
    const near = at >= span.first - 2 * AROUND && at <= span.last + 2 * AROUND;
    setSpan(
      near
        ? { first: Math.min(span.first, at - AROUND), last: Math.max(span.last, at + AROUND) }
        : { first: at - AROUND, last: at + AROUND },
    );
  }
  const window = useMemo(() => {
    const from = startOfWeek(firstOf(span.first));
    const to = addDays(startOfWeek(addDays(firstOf(span.last + 1), -1)), 7);
    const days: Date[] = [];
    for (let day = from; day < to; day = addDays(day, 1)) days.push(day);
    const windows = [];
    for (let month = span.first; month <= span.last; month++) {
      windows.push({
        from: month === span.first ? from : firstOf(month),
        to: month === span.last ? to : firstOf(month + 1),
      });
    }
    return { days, from, to, windows };
  }, [span.first, span.last]);
  const extend = useCallback(
    (direction: 1 | -1) =>
      setSpan((now) =>
        direction < 0 ? { ...now, first: now.first - AROUND } : { ...now, last: now.last + AROUND },
      ),
    [],
  );
  return { ...window, extend };
}
