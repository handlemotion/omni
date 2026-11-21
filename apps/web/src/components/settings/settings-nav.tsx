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
  useSidebar,
} from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/toast";
import { useMember } from "@/hooks/use-session.ts";
import { rememberAppHref, settingsBackHref } from "@/hooks/use-settings.ts";
import { useOpenWorkspace, useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { RailSidebar } from "@/components/shell/module-rail";
import { workspaceHref } from "@/lib/workspaces.ts";
import type { Workspace } from "@/lib/types.ts";
import { matches, type PageDefinition, useAccountPages, useWorkspacePages } from "./settings-pages";

export function SettingsNav() {
  const account = useAccountPages();
  const workspace = useWorkspacePages();
  const [query, setQuery] = useState("");
  const { isMobile } = useSidebar();
  const shownAccount = account.filter((p) => matches(p, query));
  const shownWorkspace = workspace.filter((p) => matches(p, query));

  const back = (
    <SidebarItem href={settingsBackHref()} aria-label="Back to the app">
      <IconChevronLeft className="size-icon" />
      <SidebarLabel>Settings</SidebarLabel>
    </SidebarItem>
  );
  const items = (
    <>
      <SearchField aria-label="Search settings" value={query} onChange={setQuery}>
        <SearchInput placeholder="Search settings" />
      </SearchField>
      {shownAccount.length > 0 && <Group label="Personal" pages={shownAccount} />}
      <Group label="Workspace" pages={shownWorkspace} switcher={<SettingsWorkspaceSwitcher />} />
    </>
  );
  if (!isMobile) return <RailSidebar title="Settings">{items}</RailSidebar>;
  return (
    <Sidebar closeButton={false}>
      <SidebarContent className="*:shrink-0">
        {back}
        {items}
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
