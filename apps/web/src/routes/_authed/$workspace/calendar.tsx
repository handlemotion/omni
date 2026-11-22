import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "../../../components/calendar/calendar-page.tsx";
import { calendarsQuery, warmCalendarWindow } from "../../../lib/calendar.ts";
import { parseDayKey, windowOf } from "../../../lib/calendar-grid.ts";
import { warmCalendarTasks } from "../../../lib/calendar-tasks.ts";
import { calendarSearch } from "../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/calendar")({
  validateSearch: calendarSearch,
  loaderDeps: ({ search }) => ({ date: search.date, view: search.view }),
  loader: ({ context, deps }) => {
    const { from, to } = windowOf(deps.view ?? "week", parseDayKey(deps.date));
    void context.queryClient.prefetchQuery(calendarsQuery());
    void warmCalendarWindow(context.queryClient, from, to);
    void warmCalendarTasks(context.queryClient);
  },
  component: Calendar,
});

function Calendar() {
  const { date, view, calendar, task } = Route.useSearch();
  return <CalendarPage date={date} view={view} calendar={calendar} task={task} />;
}
