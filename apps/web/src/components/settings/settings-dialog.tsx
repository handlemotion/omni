// Settings: a dialog over the workspace (Figma: Omni, settings dialog, node 40:1608). ⌘. opens
// and closes it from anywhere; so do the sidebar's Settings button and the `/settings` path.
//
// Full screen, still a dialog: it settles from 105% while the app recedes under it (the shell
// scales it to 95% and fades it). The nav lists your account's pages, then every workspace you
// belong to, the active one with its pages under it (transitive's companies); opening another
// workspace switches to it and shows its overview. The nav is the app sidebar's (240px, 13px rows 32px tall, 11px
// group labels, the search field on top), set at the right of the left 40%; the page is a 640px
// column in the right 60%, its title 17px. The page body is transitive's settings kit (`./kit`).
import { CommandLineIcon, KeyIcon } from "@heroicons/react/24/outline";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { IconInbox, IconSettings, IconTeam } from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/dialog";
import { NavList, NavListItem, NavListLabel, NavListSection } from "@/components/ui/nav-list";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { appToast } from "@/components/ui/toast";
import { Loader } from "@/components/ui/loader";
import { useMember, useSetActiveOrganization } from "@/hooks/use-session.ts";
import { useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import {
  closeSettings,
  showSettingsPage,
  toggleSettings,
  useSettingsDialog,
  type SettingsPageId,
} from "@/hooks/use-settings-dialog.ts";
import { useShortcut } from "@/hooks/use-shortcuts.ts";
import { needsSetup } from "@/lib/onboarding.ts";
import { SHORTCUT_IDS, SHORTCUTS } from "@/lib/shortcuts.ts";
import { ProfilePage, SecurityPage, ShortcutsPage } from "./account-pages";
import { SettingsPageHeader } from "./kit/settings-layout";
import {
  GeneralPage,
  MailboxesPage,
  PeoplePage,
  WorkspaceAvatar,
  WorkspaceIndexPage,
} from "./workspace-pages";

interface PageDefinition {
  id: SettingsPageId;
  title: string;
  icon: ReactNode;
  /** What the search finds it by, besides its title: its sections and the words on its rows. */
  terms: string[];
  render: () => ReactNode;
  /** The page draws its own header (the workspace index, with its mark). */
  ownHeader?: boolean;
}

/** A heroicons outline glyph drawn at the Figma icons' 15px; its 1.5 stroke lands at their 0.94. */
const outline = (Icon: typeof CommandLineIcon) => <Icon data-slot="icon" className="size-icon" />;

function useAccountPages(): PageDefinition[] {
  const { user } = useMember();
  const name = user.name || user.email;
  return useMemo(
    () => [
      {
        id: "profile",
        title: name,
        // At 15px initials are specks: a plain disc unless there's a picture, in `muted` so it
        // still reads on the current row's accent fill.
        icon: (
          <Avatar
            src={user.image ?? null}
            className="bg-muted outline-0"
            style={{ "--avatar-size": "15px" } as CSSProperties}
          />
        ),
        terms: ["profile", "email", "log out", "sign out", "accounts", "switch account"],
        render: () => <ProfilePage />,
      },
      {
        id: "security",
        title: "Security",
        icon: outline(KeyIcon),
        terms: ["passkeys", "sign in", "fingerprint", "face"],
        render: () => <SecurityPage />,
      },
      {
        id: "shortcuts",
        title: "Shortcuts",
        icon: outline(CommandLineIcon),
        terms: ["keyboard", "keys", ...SHORTCUT_IDS.map((id) => SHORTCUTS[id].label)],
        render: () => <ShortcutsPage />,
      },
    ],
    [name, user.image],
  );
}

/** The active workspace's own pages, revealed under it in the nav. */
const WORKSPACE_PAGES: PageDefinition[] = [
  {
    id: "workspace",
    title: "Overview",
    icon: null,
    terms: [],
    render: () => <WorkspaceIndexPage />,
    ownHeader: true,
  },
  {
    id: "general",
    title: "General",
    icon: <IconSettings />,
    terms: ["workspace", "name", "handle", "role"],
    render: () => <GeneralPage />,
  },
  {
    id: "people",
    title: "People",
    icon: <IconTeam />,
    terms: ["members", "invite", "invitations", "roles", "admin", "remove"],
    render: () => <PeoplePage />,
  },
  {
    id: "mailboxes",
    title: "Mailboxes",
    icon: <IconInbox />,
    terms: ["access", "shared", "unread", "inbox", "lanes", "triage"],
    render: () => <MailboxesPage />,
  },
];

function matches(page: Pick<PageDefinition, "title" | "terms">, query: string) {
  const q = query.trim().toLowerCase();
  return !q || [page.title, ...page.terms].some((term) => term.toLowerCase().includes(q));
}

/** A workspace's row in the nav, and the page it opens: `workspace:<id>`. */
const workspaceKey = (id: string) => `workspace:${id}`;

export function SettingsDialog() {
  const { isOpen, page } = useSettingsDialog();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useShortcut("settings", toggleSettings);

  return (
    <Dialog
      aria-label="Settings"
      size="full"
      bare
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (open) return;
        closeSettings();
        // `/settings` is only a way in: closing returns to the inbox, not to an empty page.
        if (pathname === "/settings") void navigate({ to: "/inbox" });
      }}
    >
      <SettingsBody page={page} />
    </Dialog>
  );
}

function SettingsBody({ page }: { page: SettingsPageId }) {
  const { member } = useMember();
  const account = useAccountPages();
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const switchTo = useSetActiveOrganization();
  const openWorkspace = useOpenWorkspace();
  const [query, setQuery] = useState("");

  const shownAccount = account.filter((p) => matches(p, query));
  const nested = WORKSPACE_PAGES.filter((p) => p.id !== "workspace" && matches(p, query));
  // Every workspace you belong to; the active one shows its pages under it. Searching keeps a
  // workspace whose name matches, and the active one while any of its pages does.
  const shownWorkspaces = workspaces.filter(
    (w) =>
      matches({ title: w.name, terms: ["workspace"] }, query) ||
      (w.id === member.orgId && nested.length > 0),
  );
  const current = [...account, ...WORKSPACE_PAGES].find((p) => p.id === page);
  const selected = page === "workspace" ? workspaceKey(member.orgId) : page;

  const select = (key: string) => {
    if (!key.startsWith("workspace:")) return showSettingsPage(key as SettingsPageId);
    const target = workspaces.find((w) => workspaceKey(w.id) === key);
    if (!target) return;
    if (target.id === member.orgId) return showSettingsPage("workspace");
    if (needsSetup(target)) {
      // An owner or admin of a workspace still being set up finishes setup first, as the
      // mailbox switcher does; anyone else just opens it (ADR 0009).
      closeSettings();
      return openWorkspace.mutate(target);
    }
    // Settings act on the active workspace (ADR 0014), so opening another one switches to it;
    // settings stays open on its overview.
    // Land on the overview first: the switch resets the cache and remounts this body, which
    // would drop a callback set here.
    showSettingsPage("workspace");
    switchTo.mutate(target.id, {
      onError: () => appToast.error("The workspace could not be opened."),
    });
  };

  return (
    // 40/60: the left part is the surface, its nav (the app sidebar's width) set 24px off the
    // divider; the page column starts on the same line as the nav.
    <div className="grid min-h-0 flex-1 grid-cols-[2fr_3fr]">
      <div className="flex min-h-0 justify-end overflow-y-auto border-e border-border bg-surface pe-6">
        <nav
          aria-label="Settings pages"
          className="flex w-sidebar shrink-0 flex-col gap-3 px-2 pt-14 pb-8"
        >
          <SearchField aria-label="Search settings" value={query} onChange={setQuery}>
            <SearchInput placeholder="Search settings" />
          </SearchField>
          {shownAccount.length === 0 && shownWorkspaces.length === 0 ? (
            <p className="px-2.25 text-sm text-muted-foreground">No settings match.</p>
          ) : (
            <NavList
              aria-label="Settings pages"
              selectedKeys={[selected]}
              onSelectionChange={(keys) => {
                const [next] = [...(keys === "all" ? [] : keys)];
                if (next) select(String(next));
              }}
            >
              {shownAccount.length > 0 && (
                <NavListSection id="account" label="Account">
                  {shownAccount.map((p) => (
                    <NavListItem key={p.id} id={p.id} textValue={p.title}>
                      {p.icon}
                      <NavListLabel>{p.title}</NavListLabel>
                    </NavListItem>
                  ))}
                </NavListSection>
              )}
              {shownWorkspaces.length > 0 && (
                <NavListSection id="workspaces" label="Workspaces">
                  {shownWorkspaces.flatMap((w) => {
                    const active = w.id === member.orgId;
                    const switching = switchTo.isPending && switchTo.variables === w.id;
                    return [
                      <NavListItem key={w.id} id={workspaceKey(w.id)} textValue={w.name}>
                        {switching ? (
                          <Loader className="size-icon text-muted-foreground" />
                        ) : (
                          <WorkspaceAvatar workspace={w} size={15} />
                        )}
                        <NavListLabel>{w.name}</NavListLabel>
                      </NavListItem>,
                      // Its pages, one step in: they read as the workspace's own.
                      ...(active
                        ? nested.map((p) => (
                            <NavListItem key={p.id} id={p.id} textValue={p.title} className="ps-6">
                              {p.icon}
                              <NavListLabel>{p.title}</NavListLabel>
                            </NavListItem>
                          ))
                        : []),
                    ];
                  })}
                </NavListSection>
              )}
            </NavList>
          )}
        </nav>
      </div>
      <div className="min-w-0 overflow-y-auto bg-background">
        <div className="max-w-160 px-12 pt-14 pb-16">
          {current && (
            <>
              {!current.ownHeader && (
                <SettingsPageHeader title={current.id === "profile" ? "Profile" : current.title} />
              )}
              {current.render()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
