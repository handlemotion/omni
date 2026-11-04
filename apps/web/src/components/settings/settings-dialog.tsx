// Settings: a dialog over the workspace (Figma: Omni, settings dialog, node 40:1608). ⌘. opens
// and closes it from anywhere; so do the sidebar's Settings button and the `/settings` path.
//
// The frame follows Figma at the app's own scale: the nav is the app sidebar's (240px, 13px rows
// 32px tall, 11px group labels, the search field on top), the page is a 640px column centred in
// the rest, its title 17px. The page body is transitive's settings kit (`./kit`).
import { CommandLineIcon, KeyIcon } from "@heroicons/react/24/outline";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { IconInbox, IconSettings, IconTeam } from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/dialog";
import { NavList, NavListItem, NavListLabel, NavListSection } from "@/components/ui/nav-list";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { useMember } from "@/hooks/use-session.ts";
import {
  closeSettings,
  showSettingsPage,
  toggleSettings,
  useSettingsDialog,
  type SettingsPageId,
} from "@/hooks/use-settings-dialog.ts";
import { useShortcut } from "@/hooks/use-shortcuts.ts";
import { SHORTCUT_IDS, SHORTCUTS } from "@/lib/shortcuts.ts";
import { ProfilePage, SecurityPage, ShortcutsPage } from "./account-pages";
import { SettingsPageHeader } from "./kit/settings-layout";
import { GeneralPage, MailboxesPage, PeoplePage } from "./workspace-pages";

interface PageDefinition {
  id: SettingsPageId;
  title: string;
  icon: ReactNode;
  /** What the search finds it by, besides its title: its sections and the words on its rows. */
  terms: string[];
  render: () => ReactNode;
}

interface Group {
  label: string;
  pages: PageDefinition[];
}

/** A heroicons outline glyph drawn at the Figma icons' 15px; its 1.5 stroke lands at their 0.94. */
const outline = (Icon: typeof CommandLineIcon) => <Icon data-slot="icon" className="size-icon" />;

function usePages(): Group[] {
  const { user } = useMember();
  const name = user.name || user.email;
  return useMemo(
    () => [
      {
        label: "Account",
        pages: [
          {
            id: "profile",
            title: name,
            // At 15px initials are specks: a plain disc unless there's a picture, in `muted` so
            // it still reads on the current row's accent fill.
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
      },
      {
        label: "Workspace",
        pages: [
          {
            id: "general",
            title: "General",
            icon: <IconSettings />,
            terms: ["workspace", "name", "handle", "role", "workspaces", "switch workspace"],
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
        ],
      },
    ],
    [name, user.image],
  );
}

function matches(page: PageDefinition, query: string) {
  const q = query.trim().toLowerCase();
  return !q || [page.title, ...page.terms].some((term) => term.toLowerCase().includes(q));
}

export function SettingsDialog() {
  const { isOpen, page } = useSettingsDialog();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useShortcut("settings", toggleSettings);

  return (
    <Dialog
      aria-label="Settings"
      size="5xl"
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (open) return;
        closeSettings();
        // `/settings` is only a way in: closing returns to the inbox, not to an empty page.
        if (pathname === "/settings") void navigate({ to: "/inbox" });
      }}
      className="h-[min(720px,calc(100dvh-64px))]"
    >
      <SettingsBody page={page} />
    </Dialog>
  );
}

function SettingsBody({ page }: { page: SettingsPageId }) {
  const groups = usePages();
  const [query, setQuery] = useState("");
  const shown = groups
    .map((group) => ({ ...group, pages: group.pages.filter((p) => matches(p, query)) }))
    .filter((group) => group.pages.length > 0);
  const current = groups.flatMap((group) => group.pages).find((p) => p.id === page);

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Settings pages"
        className="flex w-sidebar shrink-0 flex-col gap-3 overflow-y-auto border-e border-border bg-surface p-2"
      >
        <SearchField aria-label="Search settings" value={query} onChange={setQuery}>
          <SearchInput placeholder="Search settings" />
        </SearchField>
        {shown.length === 0 ? (
          <p className="px-2.25 text-sm text-muted-foreground">No settings match.</p>
        ) : (
          <NavList
            aria-label="Settings pages"
            selectedKeys={[page]}
            onSelectionChange={(keys) => {
              const [next] = [...(keys === "all" ? [] : keys)];
              if (next) showSettingsPage(next as SettingsPageId);
            }}
          >
            {shown.map((group) => (
              <NavListSection key={group.label} id={group.label} label={group.label}>
                {group.pages.map((p) => (
                  <NavListItem key={p.id} id={p.id} textValue={p.title}>
                    {p.icon}
                    <NavListLabel>{p.title}</NavListLabel>
                  </NavListItem>
                ))}
              </NavListSection>
            ))}
          </NavList>
        )}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto bg-background">
        {/* Optical: the column starts a little higher than its sides, as the Figma page does. */}
        <div className="mx-auto max-w-160 px-10 pt-9 pb-12">
          {current && (
            <>
              <SettingsPageHeader title={current.id === "profile" ? "Profile" : current.title} />
              {current.render()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
