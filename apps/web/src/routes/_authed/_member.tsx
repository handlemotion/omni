import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "../../components/shell/app-sidebar.tsx";
import { SidebarInset, SidebarProvider } from "../../components/ui/sidebar.tsx";
import { useRealtimeConnection } from "../../hooks/use-realtime.ts";
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

function Shell() {
  const { member } = Route.useRouteContext();
  useRealtimeConnection(member.id);
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
