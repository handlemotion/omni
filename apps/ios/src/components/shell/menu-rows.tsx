import type { ComponentType } from "react";
import type { SvgProps } from "react-native-svg";
import { router } from "expo-router";
import {
  IconArchive,
  IconBell,
  IconBubble,
  IconBubbleDots,
  IconBuildings,
  IconCalendar,
  IconChecklist,
  IconCircleCheck,
  IconClock,
  IconClock3,
  IconHandshake,
  IconProjects,
  IconInbox,
  IconMail,
  IconSend,
  IconTrash,
  IconUserRound,
  IconUsers,
  IconWarning,
} from "@/components/icons.ts";
import { spaceIconOf } from "@/components/drive/space-icon.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { CRM_PAGES, useActiveProjects, type CrmPage } from "@/lib/crm.ts";
import { DRIVE_PAGES, useFolder, useTeamspaces } from "@/lib/drive.ts";
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

const CRM_ICONS: Record<CrmPage, Glyph> = {
  companies: IconBuildings,
  people: IconUsers,
  deals: IconHandshake,
  projects: IconProjects,
  tasks: IconChecklist,
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

/**
 * Drive's menu, matching the web's `StorageNav`: Recents and Trash at the top, then Spaces
 * (the member's joined teamspaces, plus legacy Team/Personal spaces only when they hold files).
 */
export function DriveMenu() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const company = hasCrm(useWorkspace().active);
  const teamspaces = (useTeamspaces().data ?? []).filter((one) => one.role !== null);
  const personalCount = useFolder({ space: "personal" }).data?.length ?? 0;
  const sharedCount = useFolder({ space: "shared" }).data?.length ?? 0;
  const showTeam = company && sharedCount > 0;
  const showPersonal = personalCount > 0;
  const hasSpaces = teamspaces.length > 0 || showTeam || showPersonal;
  return (
    <>
      <MenuRow
        nav
        tint="moduleDrive"
        icon={IconClock3}
        label={DRIVE_PAGES.recents.label}
        isCurrent={place.drivePage === "recents"}
        onPress={() => {
          place.openPage("drive", "recents");
          close();
        }}
      />
      <MenuRow
        nav
        tint="moduleDrive"
        icon={IconTrash}
        label={DRIVE_PAGES.trash.label}
        isCurrent={place.drivePage === "trash"}
        onPress={() => {
          place.openPage("drive", "trash");
          close();
        }}
      />
      {hasSpaces ? (
        <>
          <MenuDivider />
          <MenuSection label="Spaces">
            {teamspaces.map((teamspace) => (
              <MenuRow
                key={teamspace.id}
                nav
                tint="moduleDrive"
                icon={spaceIconOf(teamspace)}
                label={teamspace.name}
                isCurrent={place.driveSpace === teamspace.id}
                onPress={() => {
                  place.openDriveSpace(teamspace.id);
                  close();
                }}
              />
            ))}
            {showTeam ? (
              <MenuRow
                nav
                tint="moduleDrive"
                icon={IconUsers}
                label={DRIVE_PAGES.shared.label}
                isCurrent={place.drivePage === "shared"}
                onPress={() => {
                  place.openPage("drive", "shared");
                  close();
                }}
              />
            ) : null}
            {showPersonal ? (
              <MenuRow
                nav
                tint="moduleDrive"
                icon={IconUserRound}
                label={DRIVE_PAGES.my.label}
                isCurrent={place.drivePage === "my"}
                onPress={() => {
                  place.openPage("drive", "my");
                  close();
                }}
              />
            ) : null}
          </MenuSection>
        </>
      ) : null}
    </>
  );
}

/** The CRM's lists, then its active projects and leads with their client's logo, as on the web. */
export function CrmMenu() {
  const { close } = useMenu();
  const place = useMenuPlace();
  const projects = useActiveProjects();
  return (
    <>
      {(Object.keys(CRM_PAGES) as CrmPage[]).map((id) => (
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
      ))}
      {projects.length > 0 ? (
        <>
          <MenuDivider />
          <MenuSection label="Projects">
            {projects.map(({ deal, client }) => (
              <MenuRow
                key={deal.id}
                nav
                muted
                icon={deal.stageKind === "won" ? IconProjects : IconHandshake}
                lead={
                  client ? (
                    <Avatar
                      name={client.name}
                      shape="square"
                      size={20}
                      logo={client.domain ? { domain: client.domain } : null}
                    />
                  ) : undefined
                }
                label={deal.name}
                onPress={() => {
                  place.openPage("crm", "projects");
                  close();
                  router.push({ pathname: "/crm/deal/[id]", params: { id: deal.id } });
                }}
              />
            ))}
          </MenuSection>
        </>
      ) : null}
    </>
  );
}

/** Calendar's drawer row until views and calendars land on iOS. */
export function CalendarMenu() {
  const { close } = useMenu();
  return (
    <MenuRow
      nav
      tint="moduleCalendar"
      icon={IconCalendar}
      label="Calendar"
      isCurrent
      onPress={close}
    />
  );
}
