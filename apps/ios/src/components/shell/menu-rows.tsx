import type { ComponentType } from "react";
import type { SvgProps } from "react-native-svg";
import { router } from "expo-router";
import {
  IconArchive,
  IconBell,
  IconBubble,
  IconBubbleDots,
  IconBuildings,
  IconCircleCheck,
  IconClock,
  IconFolder,
  IconFolderShared,
  IconHandshake,
  IconInbox,
  IconMail,
  IconSend,
  IconShared,
  IconTrash,
  IconUserRound,
  IconUsers,
  IconWarning,
} from "@/components/icons.ts";
import { CRM_PAGES, type CrmPage } from "@/lib/crm.ts";
import { DRIVE_PAGES, useFolder, type DrivePage } from "@/lib/drive.ts";
import { useCountedPages } from "@/lib/mail-counts.ts";
import { MAIL_PAGES, type MailPage } from "@/lib/mail.ts";
import { useUnreadNotifications } from "@/lib/notifications.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { useMenu } from "./menu-context.tsx";
import { useMenuPlace } from "./menu-nav.ts";
import { MailboxChooser } from "./mailbox-chooser.tsx";
import { MenuDivider, MenuRow, MenuSection } from "./menu-row.tsx";

type Glyph = ComponentType<SvgProps & { size?: number }>;

const VIEWS: { id: MailPage; icon: Glyph }[] = [
  { id: "inbox", icon: IconInbox },
  { id: "needsReply", icon: IconBubble },
  { id: "awaitingReply", icon: IconBubbleDots },
  { id: "later", icon: IconClock },
  { id: "done", icon: IconCircleCheck },
];

const FOLDERS: { id: MailPage; icon: Glyph }[] = [
  { id: "all", icon: IconMail },
  { id: "sent", icon: IconSend },
  { id: "archive", icon: IconArchive },
  { id: "spam", icon: IconWarning },
  { id: "trash", icon: IconTrash },
];

const DRIVE_ICONS: Record<DrivePage, Glyph> = {
  my: IconUserRound,
  shared: IconShared,
  sharedWithMe: IconFolderShared,
  trash: IconTrash,
};

const CRM_ICONS: Record<CrmPage, Glyph> = {
  companies: IconBuildings,
  people: IconUsers,
  deals: IconHandshake,
};

/**
 * Mail's rows: the mailbox chooser, then its views with their counts and Notifications, then
 * Folders.
 */
export function MailMenu() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const views = useCountedPages(VIEWS, place.mailbox);
  const notifications = useUnreadNotifications();
  const pageRow = (row: { id: MailPage; icon: Glyph; count?: string }, muted = false) => (
    <MenuRow
      key={row.id}
      nav
      icon={row.icon}
      muted={muted}
      label={MAIL_PAGES[row.id].label}
      count={row.count}
      isCurrent={place.mailPage === row.id}
      onPress={() => {
        place.openMail({ page: row.id });
        close();
      }}
    />
  );
  return (
    <>
      <MailboxChooser />
      <MenuSection label="Views">
        {views.map((row) => pageRow(row))}
        <MenuRow
          nav
          icon={IconBell}
          label="Notifications"
          count={notifications ? String(notifications) : undefined}
          onPress={() => {
            close();
            router.push("/mail/notifications");
          }}
        />
      </MenuSection>
      <MenuDivider />
      <MenuSection label="Folders">{FOLDERS.map((row) => pageRow(row, true))}</MenuSection>
    </>
  );
}

const FOLDER_SHORTCUTS = 8;

/** Drive's pages (Shared only in a company workspace), then My files' folders under Folders. */
export function DriveMenu() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const company = hasCrm(useWorkspace().active);
  const folders = (useFolder({ space: "personal" }).data ?? [])
    .filter((node) => node.kind === "folder")
    .slice(0, FOLDER_SHORTCUTS);
  const pages = (Object.keys(DRIVE_PAGES) as DrivePage[]).filter(
    (id) => company || !("company" in DRIVE_PAGES[id]),
  );
  return (
    <>
      {pages.map((id) => (
        <MenuRow
          key={id}
          nav
          tint="moduleDrive"
          icon={DRIVE_ICONS[id]}
          label={DRIVE_PAGES[id].label}
          isCurrent={place.drivePage === id}
          onPress={() => {
            place.openPage("drive", id);
            close();
          }}
        />
      ))}
      {folders.length > 0 ? (
        <>
          <MenuDivider />
          <MenuSection label="Folders">
            {folders.map((folder) => (
              <MenuRow
                key={folder.id}
                nav
                muted
                icon={IconFolder}
                label={folder.name}
                onPress={() => {
                  place.openPage("drive", "my");
                  close();
                  router.push({
                    pathname: "/drive/folder/[id]",
                    params: { id: folder.id, name: folder.name },
                  });
                }}
              />
            ))}
          </MenuSection>
        </>
      ) : null}
    </>
  );
}

/** The CRM's lists. */
export function CrmMenu() {
  const { close } = useMenu();
  const place = useMenuPlace();
  return (Object.keys(CRM_PAGES) as CrmPage[]).map((id) => (
    <MenuRow
      key={id}
      nav
      tint="moduleCrm"
      icon={CRM_ICONS[id]}
      label={CRM_PAGES[id].label}
      isCurrent={place.crmPage === id}
      onPress={() => {
        place.openPage("crm", id);
        close();
      }}
    />
  ));
}
