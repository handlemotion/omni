import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useRealtimeConnection, useRealtimeStatus } from "../../hooks/use-realtime.ts";
import { requireMember } from "../../lib/guards.ts";
import { countsQuery, mailboxesQuery } from "../../lib/mail-queries.ts";

/**
 * The app shell: every route below needs a member of the active organization. It loads what the
 * sidebar needs (mailboxes, counts) and keeps the realtime socket open.
 */
export const Route = createFileRoute("/_authed/_member")({
  beforeLoad: async ({ context, location }) => {
    const { member } = await requireMember(context.queryClient, location);
    return { member };
  },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(mailboxesQuery()),
      context.queryClient.ensureQueryData(countsQuery()),
    ]),
  component: Shell,
});

// Placeholder UI: plain navigation that proves the route map. Replace the markup freely.
function Shell() {
  const { member } = Route.useRouteContext();
  useRealtimeConnection(member.id);
  const realtime = useRealtimeStatus();
  return (
    <div>
      <nav>
        <Link to="/inbox">Inbox</Link> · <Link to="/snoozed">Snoozed</Link> ·{" "}
        <Link to="/archive">Archive</Link> · <Link to="/search">Search</Link> ·{" "}
        <Link to="/compose">Compose</Link> · <Link to="/settings">Settings</Link> · realtime:{" "}
        {realtime}
      </nav>
      <Outlet />
    </div>
  );
}
