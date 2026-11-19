import { Stack, router } from "expo-router";
import type { ReactNode } from "react";
import { signOut, useSession } from "@/lib/session.ts";
import type { SymbolName } from "@/lib/symbols.ts";
import { openWorkspace, useWorkspace, workspaceLabel } from "@/lib/workspace.ts";
import { notificationsButton } from "./notifications-button.tsx";
import { useUnreadNotifications } from "@/lib/notifications.ts";

export interface ModulePage<Id extends string> {
  id: Id;
  label: string;
  icon: SymbolName;
  /** A count beside it, as the web sidebar shows one (Inbox's unread). */
  count?: string;
}

/**
 * A module page's header buttons, native menus both: on the left, the module's pages (the web
 * sidebar's rows), the current one checked, then `children` (more sections, such as mail's
 * mailboxes); on the right, `actions` (a page's own buttons, such as New or Drive's "+"), the
 * notifications bell, and the workspace menu: every workspace the person belongs to, Settings
 * and Log out. Its items are called, not mounted: the native header keeps only direct
 * `Stack.Toolbar.*` elements, so a wrapper component would draw nothing.
 */
export function ModuleToolbar<Id extends string>(props: {
  pages: readonly ModulePage<Id>[];
  current: Id;
  onPage: (id: Id) => void;
  children?: ReactNode;
  /** Native buttons or menus before the workspace menu, such as Drive's "+". */
  actions?: ReactNode;
}) {
  const workspaceMenu = useWorkspaceMenu();
  const unread = useUnreadNotifications();
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Menu icon="line.3.horizontal" accessibilityLabel="Pages">
          <Stack.Toolbar.Menu inline>
            {props.pages.map((page) => (
              <Stack.Toolbar.MenuAction
                key={page.id}
                icon={page.icon}
                isOn={page.id === props.current}
                subtitle={page.count}
                onPress={() => page.id !== props.current && props.onPage(page.id)}
              >
                {page.label}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          {props.children}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        {props.actions}
        {notificationsButton(unread)}
        {workspaceMenu}
      </Stack.Toolbar>
    </>
  );
}

function useWorkspaceMenu() {
  const { active, all } = useWorkspace();
  const name = useSession().data?.user.name;
  if (!active) return null;
  return (
    <Stack.Toolbar.Menu
      icon={active.kind === "personal" ? "person.crop.circle" : "building.2"}
      accessibilityLabel={`Switch workspace, currently ${workspaceLabel(active, name)}`}
    >
      <Stack.Toolbar.Menu inline title="Workspaces">
        {all.map((workspace) => (
          <Stack.Toolbar.MenuAction
            key={workspace.id}
            icon={workspace.kind === "personal" ? "person" : "building.2"}
            isOn={workspace.id === active.id}
            onPress={() => openWorkspace(workspace.id)}
          >
            {workspaceLabel(workspace, name)}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
      <Stack.Toolbar.MenuAction icon="gearshape" onPress={() => router.push("/settings")}>
        Settings
      </Stack.Toolbar.MenuAction>
      <Stack.Toolbar.MenuAction
        icon="rectangle.portrait.and.arrow.right"
        onPress={() => void signOut()}
      >
        Log out
      </Stack.Toolbar.MenuAction>
    </Stack.Toolbar.Menu>
  );
}
