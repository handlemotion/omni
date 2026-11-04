// Settings: a dialog over the workspace (Figma: Omni, settings dialog, node 40:1608). ⌘. opens
// and closes it from anywhere; so do the sidebar's Settings button and the `/settings` path.
//
// Full screen, still a dialog: it settles from 105% while the app recedes under it (the shell
// scales it to 95% and fades it). The nav lists your account's pages, then a workspace chooser
// and the chosen workspace's pages under it. The nav is the app sidebar's (240px, 13px rows 32px tall, 11px
// group labels, the search field on top), set at the right of the left 40%; the page is a 640px
// column in the right 60%, its title 17px. The page body is transitive's settings kit (`./kit`).
import {
  ComputerDesktopIcon,
  CreditCardIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { cn } from "cn";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { IconKeyboard } from "@/components/icons/keyboard";
import { IconCircleDashed, IconInbox, IconSettings, IconTeam } from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/dialog";
import { NavList, NavListItem, NavListLabel, NavListSection } from "@/components/ui/nav-list";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { Button } from "@/components/ui/button";
import { appToast } from "@/components/ui/toast";
import {
  useCurrentSession,
  useDeviceSessions,
  useMember,
  useRevokeDeviceSession,
  useRevokeOtherSessions,
  useSessions,
  useSignOut,
} from "@/hooks/use-session.ts";
import type { Selection } from "react-aria-components/ListBox";
import {
  closeSettings,
  showSettingsPage,
  toggleSettings,
  useSettingsDialog,
  type SettingsPageId,
} from "@/hooks/use-settings-dialog.ts";
import { useBilling } from "@/hooks/use-billing.ts";
import { useShortcut } from "@/hooks/use-shortcuts.ts";
import { SHORTCUT_IDS, SHORTCUTS } from "@/lib/shortcuts.ts";
import { ProfilePage, SecurityPage, ShortcutsPage } from "./account-pages";
import { BillingPage } from "./billing-page";
import { SettingsPageHeader } from "./kit/settings-layout";
import { SettingsConfirmDialog } from "./kit/settings-stacked-dialog";
import { WorkspaceChooser } from "./workspace-chooser";
import { GeneralPage, MailboxesPage, PeoplePage } from "./workspace-pages";

interface PageDefinition {
  id: SettingsPageId;
  title: string;
  icon: ReactNode;
  /** What the search finds it by, besides its title: its sections and the words on its rows. */
  terms: string[];
  render: () => ReactNode;
}

/** A heroicons outline glyph drawn at the Figma icons' 15px; its 1.5 stroke lands at their 0.94. */
const outline = (Icon: typeof ShieldCheckIcon) => <Icon data-slot="icon" className="size-icon" />;

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
        terms: ["profile", "name", "email", "log out", "sign out", "accounts", "switch account"],
        render: () => <ProfilePage />,
      },
      {
        id: "security",
        title: "Security",
        // A shield, not a key: the page is passkeys and the devices you're signed in on.
        icon: outline(ShieldCheckIcon),
        terms: ["passkeys", "sign in", "fingerprint", "face", "devices", "sessions", "sign out"],
        render: () => <SecurityPage />,
      },
      {
        id: "shortcuts",
        title: "Shortcuts",
        icon: <IconKeyboard />,
        terms: ["keyboard", "keys", ...SHORTCUT_IDS.map((id) => SHORTCUTS[id].label)],
        render: () => <ShortcutsPage />,
      },
    ],
    [name, user.image],
  );
}

/** The chosen workspace's pages, under the workspace chooser in the nav. */
const WORKSPACE_PAGES: PageDefinition[] = [
  {
    id: "general",
    title: "General",
    icon: <IconSettings />,
    terms: ["workspace", "name", "rename", "handle", "role", "domain", "dns"],
    render: () => <GeneralPage />,
  },
  {
    id: "people",
    title: "People",
    icon: <IconTeam />,
    terms: ["members", "invite", "invitations", "resend", "roles", "admin", "remove"],
    render: () => <PeoplePage />,
  },
  {
    id: "mailboxes",
    title: "Mailboxes",
    icon: <IconInbox />,
    terms: ["access", "shared", "unread", "inbox", "lanes", "triage", "sync"],
    render: () => <MailboxesPage />,
  },
  {
    id: "billing",
    title: "Billing",
    icon: outline(CreditCardIcon),
    terms: ["plan", "subscription", "trial", "stripe", "invoices", "payment", "card", "usage"],
    render: () => <BillingPage />,
  },
];

/** The workspace's pages; Billing only where the install bills (ADR 0015: it is optional). */
function useWorkspacePages() {
  const billed = useBilling().data?.enabled !== false;
  return useMemo(
    () => (billed ? WORKSPACE_PAGES : WORKSPACE_PAGES.filter((p) => p.id !== "billing")),
    [billed],
  );
}

/** The paths that only open settings: closing it there returns to the inbox. */
const SETTINGS_PATHS = new Set(["/settings", "/settings/billing"]);

function matches(page: Pick<PageDefinition, "title" | "terms">, query: string) {
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
      size="full"
      bare
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (open) return;
        closeSettings();
        // `/settings` (and `/settings/billing`, where Stripe sends people back) are only ways in:
        // closing returns to the inbox, not to an empty page.
        if (SETTINGS_PATHS.has(pathname)) void navigate({ to: "/inbox" });
      }}
    >
      <SettingsBody page={page} />
    </Dialog>
  );
}

// A nav action: a page row's geometry (32px, 8px in, the 15px icon 10px before the label).
const NAV_ACTION =
  "h-8 w-full justify-start gap-2.5 rounded-lg px-2 [--btn-overlay:var(--color-accent)]";

type SessionDialog = "others" | "accounts";

/**
 * The nav's last group, under its header like the others (no hairline): leave this device or
 * account. The broader ways out show only when they would do something.
 */
function SessionGroup() {
  const session = useCurrentSession();
  const signOut = useSignOut();
  const sessions = useSessions();
  const accounts = useDeviceSessions();
  const revokeOthers = useRevokeOtherSessions();
  const revokeAccount = useRevokeDeviceSession();
  const [dialog, setDialog] = useState<SessionDialog | null>(null);
  const otherDevices = (sessions.data ?? []).filter((entry) => entry.token !== session.token);
  const otherAccounts = (accounts.data ?? []).filter(
    (entry) => entry.session.token !== session.token,
  );

  return (
    <div className="flex flex-col gap-y-0.5">
      <span className="flex h-8 shrink-0 items-center px-2.25 text-xs text-subtle-foreground">
        Session
      </span>
      {otherDevices.length > 0 && (
        <Button intent="plain" className={NAV_ACTION} onPress={() => setDialog("others")}>
          <ComputerDesktopIcon data-slot="icon" className="size-icon" />
          Sign out of other devices
        </Button>
      )}
      {otherAccounts.length > 0 && (
        <Button intent="plain" className={NAV_ACTION} onPress={() => setDialog("accounts")}>
          <UsersIcon data-slot="icon" className="size-icon" />
          Log out of all accounts
        </Button>
      )}
      <Button
        intent="plain"
        isPending={signOut.isPending}
        onPress={() => signOut.mutate()}
        className={cn(
          NAV_ACTION,
          "[--btn-foreground:var(--color-danger)] [--btn-icon:var(--color-danger)] [--btn-icon-active:var(--color-danger)] [--btn-overlay:var(--color-danger-subtle)]",
        )}
      >
        {/* The app sidebar's log out mark. */}
        <IconCircleDashed />
        Log out
      </Button>

      <SettingsConfirmDialog
        isOpen={dialog === "others"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Sign out of other devices?"
        description={`You stay signed in here. ${otherDevices.length} other ${otherDevices.length === 1 ? "device is" : "devices are"} signed out.`}
        action="Sign out"
        saving={revokeOthers.isPending}
        onConfirm={() =>
          revokeOthers.mutate(undefined, {
            onSuccess: () => setDialog(null),
            onError: () => appToast.error("The other devices could not be signed out."),
          })
        }
      />
      <SettingsConfirmDialog
        isOpen={dialog === "accounts"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Log out of all accounts?"
        description={`Every account on this browser is logged out: you and ${otherAccounts.length} more.`}
        action="Log out"
        saving={revokeAccount.isPending || signOut.isPending}
        onConfirm={async () => {
          // The other accounts first: logging out the active one resets the app.
          for (const entry of otherAccounts) await revokeAccount.mutateAsync(entry.session.token);
          signOut.mutate();
        }}
      />
    </div>
  );
}

/** Shows the page a nav list picked. */
function show(keys: Selection) {
  const [next] = [...(keys === "all" ? [] : keys)];
  if (next) showSettingsPage(next as SettingsPageId);
}

function SettingsBody({ page }: { page: SettingsPageId }) {
  const account = useAccountPages();
  const workspacePages = useWorkspacePages();
  const [query, setQuery] = useState("");
  const shownAccount = account.filter((p) => matches(p, query));
  const shownWorkspace = workspacePages.filter((p) => matches(p, query));
  // All pages, so `/settings/billing` still shows its page on an install without billing.
  const current = [...account, ...WORKSPACE_PAGES].find((p) => p.id === page);
  // Two lists, one current page: each list marks it only when it's one of its own.
  const selectedIn = (pages: PageDefinition[]) => (pages.some((p) => p.id === page) ? [page] : []);

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
          {shownAccount.length > 0 && (
            <NavList
              aria-label="Account settings"
              selectedKeys={selectedIn(account)}
              onSelectionChange={show}
            >
              <NavListSection id="account" label="Account">
                {shownAccount.map((p) => (
                  <NavListItem key={p.id} id={p.id} textValue={p.title}>
                    {p.icon}
                    <NavListLabel>{p.title}</NavListLabel>
                  </NavListItem>
                ))}
              </NavListSection>
            </NavList>
          )}
          {/* The workspace these pages act on, then its pages (the reference's org chooser). Its
              pages sit 4px under it, closer than the 12px between groups: they belong to it. */}
          <div className="flex flex-col gap-1">
            <div className="flex flex-col gap-y-0.5">
              <span className="flex h-8 shrink-0 items-center px-2.25 text-xs text-subtle-foreground">
                Workspace
              </span>
              <WorkspaceChooser />
            </div>
            {shownWorkspace.length > 0 && (
              <NavList
                aria-label="Workspace settings"
                selectedKeys={selectedIn(workspacePages)}
                onSelectionChange={show}
              >
                <NavListSection id="workspace">
                  {shownWorkspace.map((p) => (
                    <NavListItem key={p.id} id={p.id} textValue={p.title}>
                      {p.icon}
                      <NavListLabel>{p.title}</NavListLabel>
                    </NavListItem>
                  ))}
                </NavListSection>
              </NavList>
            )}
          </div>
          {shownAccount.length === 0 && shownWorkspace.length === 0 && (
            <p className="px-2.25 text-sm text-muted-foreground">No settings match.</p>
          )}
          <SessionGroup />
        </nav>
      </div>
      <div className="min-w-0 overflow-y-auto bg-background">
        <div className="max-w-160 px-12 pt-14 pb-16">
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
