import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "../../../components/calendar/calendar-page.tsx";
import { calendarsQuery } from "../../../lib/calendar.ts";
import { calendarSearch } from "../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/calendar")({
  validateSearch: calendarSearch,
  loader: ({ context }) => void context.queryClient.prefetchQuery(calendarsQuery()),
  component: Calendar,
});

function Calendar() {
  const { date, view, calendar } = Route.useSearch();
  return <CalendarPage date={date} view={view} calendar={calendar} />;
}
