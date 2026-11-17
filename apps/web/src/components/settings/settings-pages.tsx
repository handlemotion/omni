import {
  IconAi,
  IconClock3,
  IconMailOpen,
  IconCreditCard,
  IconFolder,
  IconForward,
  IconHandshake,
  IconInbox,
  IconKeyboard,
  IconMail,
  IconMailbox,
  IconSettings,
  IconShield,
  IconUsersRound,
} from "@/components/icons/central";
import { type ComponentType, type CSSProperties, type ReactNode, useMemo } from "react";
import { Avatar } from "@/components/ui/avatar";
import { useMember } from "@/hooks/use-session.ts";
import type { SettingsPageId } from "@/hooks/use-settings.ts";
import { usePersonalWorkspace } from "@/hooks/use-workspaces.ts";
import { useBilling } from "@/hooks/use-billing.ts";
import { canSyncDrive } from "@/hooks/use-desktop-sync.ts";
import { SHORTCUT_IDS, SHORTCUTS } from "@/lib/shortcuts.ts";
import { isManager } from "./workspace-pages";

export interface PageDefinition {
  id: SettingsPageId;
  title: string;
  icon: ReactNode;
  /** What the search finds it by, besides its title: its sections and the words on its rows. */
  terms: string[];
}

const glyph = (Icon: ComponentType<{ className?: string }>) => <Icon className="size-icon" />;

export const useAccountPages: () => PageDefinition[] = () => {
  const { user } = useMember();
  const name = user.name || user.email;
  return useMemo(
    () => [
      {
        id: "profile",
        title: name,
        icon: (
          <Avatar
            src={user.image ?? null}
            className="bg-muted outline-0"
            style={{ "--avatar-size": "15px" } as CSSProperties}
          />
        ),
        terms: ["profile", "name", "email", "log out", "sign out", "accounts", "switch account"],
      },
      {
        id: "security",
        title: "Security",
        icon: glyph(IconShield),
        terms: ["passkeys", "sign in", "fingerprint", "face", "devices", "sessions", "sign out"],
      },
      {
        id: "notifications",
        title: "Notifications",
        icon: glyph(IconMail),
        terms: ["desktop", "alerts", "assigned", "mentions", "customer replies", "due", "overdue"],
      },
      {
        id: "accounts",
        title: "Connected accounts",
        icon: glyph(IconMailOpen),
        terms: ["google", "gmail", "connect", "disconnect", "oauth", "personal inbox"],
      },
      {
        id: "forwarding",
        title: "Forwarding",
        icon: glyph(IconForward),
        terms: ["crm", "attio", "hubspot", "bcc", "forwarding address", "copy"],
      },
      ...(canSyncDrive
        ? [
            {
              id: "sync" as const,
              title: "Drive sync",
              icon: glyph(IconFolder),
              terms: ["finder", "files", "folder", "drive", "storage", "this mac", "offline"],
            },
          ]
        : []),
      {
        id: "shortcuts",
        title: "Shortcuts",
        icon: glyph(IconKeyboard),
        terms: ["keyboard", "keys", ...SHORTCUT_IDS.map((id) => SHORTCUTS[id].label)],
      },
    ],
    [name, user.image],
  );
};

/** The active workspace's pages, under the workspace switcher in the nav. */
export const WORKSPACE_PAGES: PageDefinition[] = [
  {
    id: "general",
    title: "General",
    icon: glyph(IconSettings),
    terms: ["workspace", "name", "rename", "handle", "role", "domain", "dns"],
  },
  {
    id: "people",
    title: "People",
    icon: glyph(IconUsersRound),
    terms: [
      "members",
      "invite",
      "invitations",
      "resend",
      "roles",
      "admin",
      "remove",
      "personal inbox",
      "create inbox",
    ],
  },
  {
    id: "inboxes",
    title: "Inboxes",
    icon: glyph(IconInbox),
    terms: ["mailboxes", "your mailboxes", "personal", "unread", "lanes", "triage", "sync"],
  },
  {
    id: "shared",
    title: "Shared",
    icon: glyph(IconMailbox),
    terms: ["shared mailboxes", "access", "who can see", "team", "add mailbox", "hello"],
  },
  {
    id: "helpdesk",
    title: "Helpdesk",
    icon: glyph(IconClock3),
    terms: [
      "sla",
      "response targets",
      "first reply",
      "resolution",
      "business hours",
      "time zone",
      "auto-assign",
      "round robin",
      "assignment",
      "tags",
    ],
  },
  {
    id: "pipeline",
    title: "Pipeline",
    icon: glyph(IconHandshake),
    terms: ["crm", "stages", "deals", "won", "lost", "board", "rename", "reorder"],
  },
  {
    id: "ai",
    title: "AI",
    icon: glyph(IconAi),
    terms: ["roles", "assign", "assignment", "triage", "jev", "tags", "descriptions", "labels"],
  },
  {
    id: "billing",
    title: "Billing",
    icon: glyph(IconCreditCard),
    terms: ["plan", "subscription", "trial", "stripe", "invoices", "payment", "card", "usage"],
  },
];

/** Pages only a company has: a Personal space has no team, shared inboxes or plan (ADR 0024). */
export const COMPANY_PAGES = new Set(["people", "shared", "helpdesk", "pipeline", "ai", "billing"]);
const MANAGER_PAGES = new Set(["ai", "pipeline"]);

/**
 * The workspace's pages; Billing only where the install bills (ADR 0015: it is optional), and
 * none of the company pages in a Personal space.
 */
export function useWorkspacePages() {
  const billed = useBilling().data?.enabled !== false;
  const personal = usePersonalWorkspace();
  const manager = isManager(useMember().member.role);
  return useMemo(
    () =>
      WORKSPACE_PAGES.filter(
        (p) =>
          (billed || p.id !== "billing") &&
          !(personal && COMPANY_PAGES.has(p.id)) &&
          (manager || !MANAGER_PAGES.has(p.id)),
      ),
    [billed, personal, manager],
  );
}

export function matches(page: Pick<PageDefinition, "title" | "terms">, query: string) {
  const q = query.trim().toLowerCase();
  return !q || [page.title, ...page.terms].some((term) => term.toLowerCase().includes(q));
}
