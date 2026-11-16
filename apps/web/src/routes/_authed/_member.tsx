import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { ComposeDialog } from "../../components/compose/compose-pane.tsx";
import { ListSweepProvider } from "../../components/inbox/list-sweep.tsx";
import { SettingsNav } from "../../components/settings/settings-nav.tsx";
import { AppSidebar } from "../../components/shell/app-sidebar.tsx";
import { KeyboardShortcuts } from "../../components/shell/keyboard-shortcuts.tsx";
import { NotificationsPanel } from "../../components/shell/notifications.tsx";
import {
  ResizableSidebarProvider,
  SidebarResizeGrip,
} from "../../components/shell/sidebar-resize.tsx";
import { SidebarInset } from "../../components/ui/sidebar.tsx";
import { isSettingsPath, rememberAppHref, useToggleSettings } from "../../hooks/use-settings.ts";
import { useShortcut } from "../../hooks/use-shortcuts.ts";
import { useDesktopNotifications } from "../../hooks/use-desktop-notifications.ts";
import { usePreloadScreens } from "../../hooks/use-preload-screens.ts";
import { useRealtimeConnection } from "../../hooks/use-realtime.ts";
import { billingQuery } from "../../lib/billing.ts";
import { requireMember } from "../../lib/guards.ts";
import { allMailboxesQuery, countsQuery, mailboxesQuery } from "../../lib/mail-queries.ts";
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
      context.queryClient.ensureQueryData(allMailboxesQuery()),
      context.queryClient.ensureQueryData(countsQuery()),
      context.queryClient.ensureQueryData(workspacesQuery()),
    ]);
  },
  component: Shell,
});

function Shell() {
  const { member } = Route.useRouteContext();
  useRealtimeConnection(member.orgId, { memberId: member.id });
  useDesktopNotifications();
  usePreloadScreens();
  const settings = useSettingsLocation();
  useShortcut("settings", useToggleSettings());
  return (
    // The page itself never scrolls: it is the window's size, and the list and the open thread
    // scroll on their own inside it.
    <ResizableSidebarProvider className="h-svh overflow-hidden">
      {/* Above the sidebar too: its search sweeps the list when smart search runs. */}
      <ListSweepProvider>
        {/* Settings is a page: its nav takes the sidebar's place. */}
        {settings ? <SettingsNav /> : <AppSidebar />}
        <NotificationsPanel />
        <SidebarInset>
          <SidebarResizeGrip />
          <Outlet />
        </SidebarInset>
      </ListSweepProvider>
      <KeyboardShortcuts />
      <ComposeDialog />
    </ResizableSidebarProvider>
  );
}

/** Whether a settings page is open; anywhere else is remembered as where its Back returns. */
function useSettingsLocation() {
  const { pathname, href } = useLocation();
  const settings = isSettingsPath(pathname);
  useEffect(() => {
    if (!settings) rememberAppHref(href);
  }, [settings, href]);
  return settings;
}
