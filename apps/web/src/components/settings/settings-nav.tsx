// Settings' nav, in the sidebar's place while a settings page is open: the app sidebar's own
// rows, groups and proportions. Back to where the app was, the search field, then two groups that
// never collapse: Personal (your account's pages) and Workspace (the workspace switcher, then the
// active workspace's pages). The switcher here lists only the workspaces and New workspace; its
// settings links would point back into this nav.
import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { IconChevronLeft } from "@/components/icons/central";
import { moduleHome, WorkspaceSwitcher } from "@/components/shell/module-switcher";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import {
  Sidebar,
  SidebarContent,
  SidebarItem,
  SidebarLabel,
  SidebarSection,
} from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/toast";
import { useMember } from "@/hooks/use-session.ts";
import { rememberAppHref, settingsBackHref } from "@/hooks/use-settings.ts";
import { useOpenWorkspace, useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { desktop } from "@/lib/desktop.ts";
import { workspaceHref } from "@/lib/workspaces.ts";
import type { Workspace } from "@/lib/types.ts";
import { matches, type PageDefinition, useAccountPages, useWorkspacePages } from "./settings-pages";

export function SettingsNav() {
  const account = useAccountPages();
  const workspace = useWorkspacePages();
  const [query, setQuery] = useState("");
  const shownAccount = account.filter((p) => matches(p, query));
  const shownWorkspace = workspace.filter((p) => matches(p, query));

  return (
    <Sidebar closeButton={false}>
      <SidebarContent className="*:shrink-0">
        {/* In the desktop app the title bar's group takes the first row, as in the app's sidebar. */}
        {desktop.isDesktop && <div aria-hidden className="h-8" />}
        <SidebarItem href={settingsBackHref()} aria-label="Back to the app">
          <IconChevronLeft className="size-icon" />
          <SidebarLabel>Settings</SidebarLabel>
        </SidebarItem>
        {/* Its own step in the content's 12px rhythm: as far from Back as from the first group. */}
        <SearchField aria-label="Search settings" value={query} onChange={setQuery}>
          <SearchInput placeholder="Search settings" />
        </SearchField>
        {shownAccount.length > 0 && <Group label="Personal" pages={shownAccount} />}
        {/* The switcher stays while the search hides pages: it is what the pages act on. */}
        <Group label="Workspace" pages={shownWorkspace} switcher={<SettingsWorkspaceSwitcher />} />
      </SidebarContent>
    </Sidebar>
  );
}

function Group(props: { label: string; pages: PageDefinition[]; switcher?: ReactNode }) {
  const { pathname } = useLocation();
  const workspace = useWorkspaceSlug();
  return (
    <SidebarSection label={props.label}>
      {props.switcher}
      {props.pages.map((p) => (
        <SidebarItem
          key={p.id}
          href={workspaceHref(workspace, `/settings/${p.id}`)}
          isCurrent={pathname === workspaceHref(workspace, `/settings/${p.id}`)}
        >
          {p.icon}
          <SidebarLabel>{p.title}</SidebarLabel>
        </SidebarItem>
      ))}
    </SidebarSection>
  );
}

/**
 * The sidebar's workspace switcher, with only the workspaces and New workspace. Choosing one keeps
 * this settings page, now acting on it (ADR 0014); Back then opens the same module's home there,
 * since a thread or folder belongs to the workspace left behind. An owner or admin of a workspace
 * still being set up goes to onboarding instead (ADR 0009).
 */
function SettingsWorkspaceSwitcher() {
  const { member } = useMember();
  const openWorkspace = useOpenWorkspace();
  const choose = (target: Workspace) => {
    if (target.id === member.orgId) return;
    const back = moduleHome(
      new URL(settingsBackHref(), window.location.origin).pathname,
      target.slug,
    );
    openWorkspace.mutate(target, {
      onSuccess: () => rememberAppHref(back),
      onError: () => appToast.error("The workspace could not be opened."),
    });
  };
  return <WorkspaceSwitcher onChoose={choose} pending={openWorkspace.isPending} workspacesOnly />;
}
