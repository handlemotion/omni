import { createFileRoute, notFound, Outlet, redirect, useLocation } from "@tanstack/react-router";
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
import { useThreadInItsWorkspace } from "../../hooks/use-workspaces.ts";
import { billingQuery } from "../../lib/billing.ts";
import { currentWorkspaceId } from "../../lib/current-workspace.ts";
import { requireMember, requireUser } from "../../lib/guards.ts";
import { allMailboxesQuery, countsQuery, mailboxesQuery } from "../../lib/mail-queries.ts";
import {
  enterWorkspace,
  homeWorkspace,
  inOtherWorkspace,
  workspaceOfMailbox,
  workspacesWith,
  legacyPath,
  workspaceBySlug,
  workspaceHome,
  workspacesQuery,
} from "../../lib/workspaces.ts";

/**
 * The app shell, inside the workspace the URL names by slug (ADR 0043): every route below needs
 * the user's member there. Entering it makes it this tab's workspace (every API call names it)
 * and drops anything cached for another. A slug the user has no workspace for is a path from
 * before workspaces were in the URL (`/inbox`), sent on under the session's workspace, or else
 * that workspace's Inbox. The shell loads what the sidebar needs (mailboxes, counts, workspaces)
 * and keeps the workspace's realtime socket open.
 */
export const Route = createFileRoute("/_authed/$workspace")({
  beforeLoad: async ({ context, location, params, preload }) => {
    const client = context.queryClient;
    await requireUser(client, location);
    const workspaces = await workspacesWith(client, (d) => !!workspaceBySlug(d, params.workspace));
    const workspace = workspaceBySlug(workspaces, params.workspace);
    if (!workspace) {
      const home = homeWorkspace(workspaces);
      // No workspace at all: the member guard knows where to go (join, onboarding, sign-in).
      if (!home) await requireMember(client, location);
      const moved = home && legacyPath(home.slug, location.pathname);
      const href = moved ? `${moved}${location.searchStr}` : home && workspaceHome(home.slug);
      throw redirect({ href: href ?? "/", replace: true });
    }
    // A mailbox (`?mailbox=`) or thread of another of the user's workspaces is opened there:
    // the Worker would read it as that workspace's member, under this one's name.
    const { mailbox } = location.search as { mailbox?: string };
    const owner = mailbox && workspaceOfMailbox(workspaces, mailbox);
    if (owner && owner.id !== workspace.id) {
      throw redirect({ href: inOtherWorkspace(location.href, owner.slug), replace: true });
    }
    // A link into another workspace is not preloaded: entering it is what a click does, and
    // a hover must not move this tab (TanStack Router drops a preload that is not found).
    if (preload && workspace.id !== currentWorkspaceId()) throw notFound();
    await enterWorkspace(client, workspace);
    const { member } = await requireMember(client, location);
    return { member, workspace };
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
  useThreadInItsWorkspace();
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
