import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "../../../components/calendar/calendar-page.tsx";
import { firstOf, monthOf } from "../../../components/calendar/month-span.ts";
import { calendarsQuery, warmCalendarWindow } from "../../../lib/calendar.ts";
import { DEFAULT_VIEW, parseDayKey, windowOf } from "../../../lib/calendar-grid.ts";
import { warmCalendarTasks } from "../../../lib/calendar-tasks.ts";
import { calendarSearch } from "../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/calendar")({
  validateSearch: calendarSearch,
  loaderDeps: ({ search }) => ({ date: search.date, view: search.view }),
  loader: ({ context, deps }) => {
    const view = deps.view ?? DEFAULT_VIEW;
    const anchor = parseDayKey(deps.date);
    const { from, to } =
      view === "month"
        ? { from: firstOf(monthOf(anchor)), to: firstOf(monthOf(anchor) + 1) }
        : windowOf(view, anchor);
    void context.queryClient.prefetchQuery(calendarsQuery());
    void warmCalendarWindow(context.queryClient, from, to);
    void warmCalendarTasks(context.queryClient);
  },
  component: Calendar,
});

function Calendar() {
  const { date, view, task } = Route.useSearch();
  return <CalendarPage date={date} view={view} task={task} />;
}
