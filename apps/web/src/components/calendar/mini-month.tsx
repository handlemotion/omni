import { CalendarDate, getLocalTimeZone, today } from "@internationalized/date";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useRef, useState } from "react";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
} from "react-aria-components/Calendar";
import { Heading } from "react-aria-components/Heading";
import { IconChevronDown, IconChevronUp } from "@/components/icons/central";
import { AriaButton } from "@/components/ui/aria-button";
import { useWheelStep } from "@/hooks/use-wheel-step.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { dayKey, parseDayKey, startOfWeek, type CalendarView } from "@/lib/calendar-grid.ts";

const toDate = (value: CalendarDate) => new Date(value.year, value.month - 1, value.day);
const ofDate = (date: Date) =>
  new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate());

function inShown(date: CalendarDate, from: Date, view: CalendarView) {
  if (view === "month") return null;
  const day = toDate(date).getTime();
  const start = from.getTime();
  const last = view === "day" ? start : new Date(from).setDate(from.getDate() + 6);
  if (day < start || day > last) return null;
  return { first: day === start, last: day === last };
}

/** The month around the shown day; a day picks it, and the shown week or day stays tinted. */
export function MiniMonth() {
  const search = useSearch({ strict: false }) as { date?: string; view?: CalendarView };
  const view = search.view ?? "week";
  const anchor = parseDayKey(search.date);
  const from = view === "day" ? anchor : startOfWeek(anchor);
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const [focused, setFocused] = useState(() => ofDate(anchor));
  const [shownFor, setShownFor] = useState(dayKey(anchor));
  if (shownFor !== dayKey(anchor)) {
    setShownFor(dayKey(anchor));
    setFocused(ofDate(anchor));
  }
  const now = today(getLocalTimeZone());
  const box = useRef<HTMLDivElement>(null);
  useWheelStep(box, "y", (delta) => setFocused((at) => at.add({ months: delta })));
  return (
    <div ref={box}>
      <Calendar
        aria-label="Month"
        firstDayOfWeek="mon"
        value={ofDate(anchor)}
        focusedValue={focused}
        onFocusChange={setFocused}
        onChange={(value) =>
          void navigate({
            to: "/$workspace/calendar",
            params: { workspace },
            search: (prev) => ({ ...prev, date: dayKey(toDate(value)), view }),
            replace: true,
          })
        }
        className="px-2"
      >
        <header className="-mx-2.5 grid h-11 grid-cols-7 items-center">
          <Heading className="col-span-5 ps-2.5 text-md" />
          <AriaButton
            slot="previous"
            size="sq-xs"
            intent="plain"
            aria-label="Previous month"
            className="justify-self-center"
          >
            <IconChevronUp />
          </AriaButton>
          <AriaButton
            slot="next"
            size="sq-xs"
            intent="plain"
            aria-label="Next month"
            className="justify-self-center"
          >
            <IconChevronDown />
          </AriaButton>
        </header>
        <div className="min-h-[calc(7*--spacing(7))]">
          <CalendarGrid
            weekdayStyle="narrow"
            className="-mx-2.5 w-[calc(100%+--spacing(5))] border-collapse"
          >
            <CalendarGridHeader>
              {(day) => (
                <CalendarHeaderCell className="h-7 text-xs font-normal text-muted-foreground">
                  {day}
                </CalendarHeaderCell>
              )}
            </CalendarGridHeader>
            <CalendarGridBody>
              {(date) => {
                const shown = inShown(date, from, view);
                return (
                  <CalendarCell
                    date={date}
                    className={({ isOutsideMonth, isFocusVisible, isHovered }) =>
                      cn(
                        "flex h-7 cursor-default items-center justify-center text-xs tabular-nums outline-hidden",
                        isOutsideMonth ? "text-subtle-foreground" : "text-foreground",
                        shown && "bg-secondary",
                        shown?.first && "rounded-s-md",
                        shown?.last && "rounded-e-md",
                        !shown && isHovered && "rounded-md bg-hover",
                        isFocusVisible && "rounded-md ring-2 ring-ring",
                      )
                    }
                  >
                    {({ formattedDate }) => (
                      <span
                        className={cn(
                          "grid size-6 place-items-center rounded-md",
                          date.compare(now) === 0 && "bg-module-calendar text-primary-foreground",
                        )}
                      >
                        {formattedDate}
                      </span>
                    )}
                  </CalendarCell>
                );
              }}
            </CalendarGridBody>
          </CalendarGrid>
        </div>
      </Calendar>
    </div>
  );
}
