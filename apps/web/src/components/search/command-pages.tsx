import type { ReactNode } from "react";
import {
  IconBuildings,
  IconFolder,
  IconFolderShared,
  IconHandshake,
  IconUserRound,
  IconUsers,
} from "@/components/icons/central";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconClock,
  IconEmail,
  IconInbox,
  IconPaperPlane,
  IconTrash,
  IconWarning,
  IconWrite,
} from "@/components/icons/sidebar";
import type { ShortcutId } from "@/lib/shortcuts.ts";

// The command menu's places, one list per module, with the same names, icons and paths as the
// module's own sidebar. Paths are workspace-relative (`workspaceHref` adds the slug).

export interface Page {
  id: string;
  title: string;
  icon: ReactNode;
  href: string;
  /** The go-to keys that open it, shown on the row and run instead of `href`. */
  shortcut?: ShortcutId;
}

export const MAIL_PAGES: Page[] = [
  { id: "inbox", title: "Inbox", icon: <IconInbox />, href: "/mail/inbox", shortcut: "goInbox" },
  {
    id: "needs-reply",
    title: "Needs reply",
    icon: <IconBubble />,
    href: "/mail/inbox?lane=needs_reply",
  },
  {
    id: "awaiting-reply",
    title: "Awaiting reply",
    icon: <IconBubbleAnnotation />,
    href: "/mail/inbox?lane=waiting_on_them",
  },
  { id: "later", title: "Later", icon: <IconClock />, href: "/mail/later", shortcut: "goLater" },
  { id: "all", title: "All mail", icon: <IconEmail />, href: "/mail/all", shortcut: "goAll" },
  { id: "drafts", title: "Drafts", icon: <IconWrite />, href: "/mail/drafts" },
  { id: "sent", title: "Sent", icon: <IconPaperPlane />, href: "/mail/sent" },
  { id: "mail-trash", title: "Trash", icon: <IconTrash />, href: "/mail/trash" },
  { id: "spam", title: "Spam", icon: <IconWarning />, href: "/mail/spam" },
];

/** Drive's places; Shared (the team's drive) only in a company workspace, as its nav has it. */
export function drivePages(company: boolean): Page[] {
  return [
    {
      id: "my-files",
      title: "My files",
      icon: <IconFolder />,
      href: "/files/my",
      shortcut: "goDrive",
    },
    ...(company
      ? [{ id: "shared", title: "Shared", icon: <IconFolderShared />, href: "/files/shared" }]
      : []),
    {
      id: "shared-with-me",
      title: "Shared with me",
      icon: <IconUserRound />,
      href: "/files/shared-with-me",
    },
    { id: "drive-trash", title: "Trash", icon: <IconTrash />, href: "/files/trash" },
  ];
}

export const CRM_PAGES: Page[] = [
  { id: "companies", title: "Companies", icon: <IconBuildings />, href: "/crm/companies" },
  { id: "people", title: "People", icon: <IconUsers />, href: "/crm/people" },
  { id: "deals", title: "Deals", icon: <IconHandshake />, href: "/crm/deals" },
];
