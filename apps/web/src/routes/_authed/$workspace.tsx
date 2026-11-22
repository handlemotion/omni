import {
  createFileRoute,
  notFound,
  Outlet,
  redirect,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { ComposeDialog } from "../../components/compose/compose-pane.tsx";
import { ModuleBoundary } from "../../components/errors/error-boundary.tsx";
import { ListSweepProvider } from "../../components/inbox/list-sweep.tsx";
import { SettingsNav } from "../../components/settings/settings-nav.tsx";
import { AppSidebar } from "../../components/shell/app-sidebar.tsx";
import { DriveDragProvider } from "../../components/storage/drive-drag.tsx";
import { TitleBar } from "../../components/shell/title-bar.tsx";
import { TalkWindow } from "../../components/talk/talk-window.tsx";
import { useTalkNotifications } from "../../components/talk/use-talk-notifications.ts";
import { CommandMenu } from "../../components/search/command-menu.tsx";
import { KeyboardShortcuts } from "../../components/shell/keyboard-shortcuts.tsx";
import { NotificationsPanel } from "../../components/shell/notifications.tsx";
import { OfflineNotice } from "../../components/shell/offline-notice.tsx";
import {
  ResizableSidebarProvider,
  SidebarResizeGrip,
} from "../../components/shell/sidebar-resize.tsx";
import { SidebarInset } from "../../components/ui/sidebar.tsx";
import { isSettingsPath, rememberAppHref, useToggleSettings } from "../../hooks/use-settings.ts";
import { useShortcut } from "../../hooks/use-shortcuts.ts";
import { useDesktopNotifications } from "../../hooks/use-desktop-notifications.ts";
import { useDesktopShortcuts } from "../../hooks/use-desktop-shortcuts.ts";
import { useDesktopSyncSetup } from "../../hooks/use-desktop-sync.ts";
import { useDockBadge } from "../../hooks/use-dock-badge.ts";
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
 * The app shell, inside the workspace the URL names by slug: every route below needs
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
      if (!home) await requireMember(client, location);
      const moved = home && legacyPath(home.slug, location.pathname);
      const href = moved ? `${moved}${location.searchStr}` : home && workspaceHome(home.slug);
      throw redirect({ href: href ?? "/", replace: true });
    }
    const { mailbox } = location.search as { mailbox?: string };
    const owner = mailbox && workspaceOfMailbox(workspaces, mailbox);
    if (owner && owner.id !== workspace.id) {
      throw redirect({
        href: inOtherWorkspace(location.href, owner.slug),
        replace: true,
      });
    }
    if (preload && workspace.id !== currentWorkspaceId()) throw notFound();
    await enterWorkspace(client, workspace);
    const { member } = await requireMember(client, location);
    return { member, workspace };
  },
  loader: ({ context }) => {
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
  useTalkNotifications(member.id);
  useDesktopNotifications();
  useDockBadge();
  useDesktopSyncSetup();
  useDesktopShortcuts();
  usePreloadScreens();
  const settings = useSettingsLocation();
  useShortcut("settings", useToggleSettings());
  return (
    <ResizableSidebarProvider className="h-svh overflow-hidden bg-shell">
      <ListSweepProvider>
        <DriveDragProvider>
          {settings ? <SettingsNav /> : <AppSidebar />}
          <NotificationsPanel />
          <CommandMenu />
          <SidebarInset className="md:mt-12 md:border-t md:border-sidebar-border md:peer-data-[state=collapsed]:rounded-tl-xl md:peer-data-[state=collapsed]:border-s">
            <SidebarResizeGrip />
            <ModuleBoundary>
              <Outlet />
            </ModuleBoundary>
          </SidebarInset>
        </DriveDragProvider>
      </ListSweepProvider>
      <TitleBar />
      <TalkWindow />
      <KeyboardShortcuts />
      <OfflineNotice />
      <ComposeDialog />
    </ResizableSidebarProvider>
  );
}

function useSettingsLocation() {
  const router = useRouter();
  const settings = useLocation({
    select: (location) => isSettingsPath(location.pathname),
  });
  useEffect(() => {
    const remember = () => {
      const { pathname, href } = router.state.location;
      if (!isSettingsPath(pathname)) rememberAppHref(href);
    };
    remember();
    return router.subscribe("onResolved", remember);
  }, [router]);
  return settings;
}
