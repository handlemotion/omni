import { cn } from "cn";
import {
  IconCalendarDay,
  IconCalendarMonth,
  IconCalendarWeek,
  IconChevronDown,
  IconChevronRight,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { startOfWeek, type CalendarView } from "@/lib/calendar-grid.ts";

const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const weekdayName = new Intl.DateTimeFormat(undefined, { weekday: "short" });

const VIEWS = [
  { id: "month", name: "Month", icon: IconCalendarMonth },
  { id: "week", name: "Week", icon: IconCalendarWeek },
  { id: "day", name: "Day", icon: IconCalendarDay },
] as const;
const DEPTH = { month: 0, week: 1, day: 2 } as const;

/** The ISO week number of `date`. */
export function isoWeek(date: Date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/**
 * Where the calendar is, as crumbs that deepen with the view: the month, then its week, then the
 * day. An earlier crumb zooms out to it; the last one picks the view.
 */
export function CalendarCrumbs(props: {
  view: CalendarView;
  anchor: Date;
  onView: (view: CalendarView) => void;
}) {
  const depth = DEPTH[props.view];
  const crumbs = [
    { view: "month" as const, label: monthYear.format(props.anchor) },
    { view: "week" as const, label: `W${isoWeek(startOfWeek(props.anchor))}` },
    {
      view: "day" as const,
      label: `${weekdayName.format(props.anchor)} ${props.anchor.getDate()}`,
    },
  ].slice(0, depth + 1);
  return (
    <Heading className="-ms-1.5 flex min-w-0 items-center gap-0.5 text-md">
      {crumbs.map((crumb, at) => {
        const last = at === crumbs.length - 1;
        return (
          <span key={crumb.view} className="flex min-w-0 items-center gap-0.5">
            {at > 0 && (
              <IconChevronRight aria-hidden className="size-3.5 shrink-0 text-subtle-foreground" />
            )}
            {last ? (
              <MenuTrigger>
                <Button
                  intent="plain"
                  size="sm"
                  aria-label={`${crumb.label}, change view`}
                  className="px-1.5 text-md tabular-nums"
                >
                  {crumb.label}
                  <IconChevronDown className="text-muted-foreground" />
                </Button>
                <Menu placement="bottom start">
                  {VIEWS.map((item) => (
                    <MenuItem key={item.id} id={item.id} onAction={() => props.onView(item.id)}>
                      <item.icon data-slot="icon" />
                      <MenuLabel>{item.name}</MenuLabel>
                    </MenuItem>
                  ))}
                </Menu>
              </MenuTrigger>
            ) : (
              <Button
                intent="plain"
                size="sm"
                onPress={() => props.onView(crumb.view)}
                className={cn("px-1.5 text-md text-muted-foreground tabular-nums")}
              >
                {crumb.label}
              </Button>
            )}
          </span>
        );
      })}
    </Heading>
  );
}
