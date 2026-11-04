import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ListSweepProvider } from "../../components/inbox/list-sweep.tsx";
import { AppSidebar } from "../../components/shell/app-sidebar.tsx";
import { SettingsDialog } from "../../components/settings/settings-dialog.tsx";
import { KeyboardShortcuts } from "../../components/shell/keyboard-shortcuts.tsx";
import { SidebarInset, SidebarProvider } from "../../components/ui/sidebar.tsx";
import { useSettingsDialog } from "../../hooks/use-settings-dialog.ts";
import { useRealtimeConnection } from "../../hooks/use-realtime.ts";
import { billingQuery } from "../../lib/billing.ts";
import { requireMember } from "../../lib/guards.ts";
import { countsQuery, mailboxesQuery } from "../../lib/mail-queries.ts";
import { workspacesQuery } from "../../lib/workspaces.ts";

/**
 * The app shell: every route below needs a member of the active organization. It loads what the
 * sidebar needs (mailboxes, counts, workspaces) and keeps a realtime socket open per workspace.
 */
export const Route = createFileRoute("/_authed/_member")({
  beforeLoad: async ({ context, location }) => {
    const { member } = await requireMember(context.queryClient, location);
    return { member };
  },
  loader: ({ context }) => {
    // Not awaited: settings' nav shows Billing only where the install bills, and this has the
    // answer ready long before anyone opens settings.
    void context.queryClient.prefetchQuery(billingQuery());
    return Promise.all([
      context.queryClient.ensureQueryData(mailboxesQuery()),
      context.queryClient.ensureQueryData(countsQuery()),
      context.queryClient.ensureQueryData(workspacesQuery()),
    ]);
  },
  component: Shell,
});

function Shell() {
  const { member } = Route.useRouteContext();
  useRealtimeConnection(member.orgId, { memberId: member.id, everyWorkspace: true });
  const settings = useSettingsDialog();
  return (
    // While settings is open the whole app recedes under it: 100% to 95% and fading, as settings
    // settles from 105% to 100% on top (a parallax stack). Same length and curve as the dialog.
    <SidebarProvider
      className={
        "origin-center transition-[scale,opacity] duration-300 ease-out motion-reduce:transition-none " +
        (settings.isOpen ? "scale-95 opacity-40" : "")
      }
    >
      <AppSidebar />
      <SidebarInset>
        <ListSweepProvider>
          <Outlet />
        </ListSweepProvider>
      </SidebarInset>
      <KeyboardShortcuts />
      <SettingsDialog />
    </SidebarProvider>
  );
}
