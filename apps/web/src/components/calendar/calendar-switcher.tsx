import { useNavigate, useSearch } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { MailboxAvatar } from "@/components/avatar/mailbox-avatar";
import {
  IconCalendar,
  IconChevronsUpDown,
  IconCircleCheckFilled,
} from "@/components/icons/central";
import { mailboxName } from "@/components/shell/mailbox-switcher";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { SidebarItemTrigger } from "@/components/ui/sidebar";
import { useCalendars } from "@/hooks/use-calendar.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useWorkspaces, useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import type { CalendarItem } from "@/lib/calendar.ts";

const FACE = "bg-secondary text-foreground outline-0 mix-blend-multiply";

function Label({ name, current }: { name: string; current: boolean }) {
  return (
    <MenuLabel className="col-[2/-1] flex min-w-0 items-center justify-between gap-3">
      <span className="truncate">{name}</span>
      {current && <IconCircleCheckFilled className="size-4 shrink-0 text-primary" />}
    </MenuLabel>
  );
}

/** Which calendars the grid shows, at the sidebar's foot: all of them, or one inbox's. */
export function CalendarSwitcher() {
  const calendars = useCalendars().data ?? [];
  const { user, member } = useMember();
  const workspaces = useWorkspaces();
  const mailboxes =
    workspaces.data?.workspaces.find((workspace) => workspace.id === member.orgId)?.mailboxes ?? [];
  const { calendar: current } = useSearch({ strict: false }) as { calendar?: string };
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const you = user.name || user.email;
  const boxOf = (calendar: CalendarItem) => mailboxes.find((box) => box.id === calendar.mailboxId);
  const nameOf = (calendar: CalendarItem) => {
    const box = boxOf(calendar);
    return box ? mailboxName(box, you) : calendar.address;
  };
  const face = (calendar: CalendarItem, size: number) => {
    const box = boxOf(calendar);
    const style = { "--avatar-size": `${size}px` } as CSSProperties;
    return box ? (
      <MailboxAvatar mailbox={box} name={nameOf(calendar)} className={FACE} style={style} />
    ) : (
      <IconCalendar data-slot="icon" />
    );
  };
  const pick = (id: string | undefined) =>
    void navigate({
      to: "/$workspace/calendar",
      params: { workspace },
      search: (prev) => ({ ...prev, calendar: id }),
      replace: true,
    });
  if (calendars.length === 0) return null;
  const shown = calendars.find((calendar) => calendar.id === current);
  const name = shown ? nameOf(shown) : "All calendars";
  return (
    <MenuTrigger>
      <SidebarItemTrigger aria-label={`Switch calendar, currently ${name}`}>
        <span className="grid size-icon shrink-0 place-items-center">
          {shown ? (
            <span className="-m-[1.5px]">{face(shown, 18)}</span>
          ) : (
            <IconCalendar className="size-icon text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 truncate">{name}</span>
        <IconChevronsUpDown className="ms-auto -me-0.75 size-3.5 shrink-0 text-subtle-foreground group-hover/sidebar-item:text-foreground group-aria-expanded/sidebar-item:text-foreground" />
      </SidebarItemTrigger>
      <Menu
        placement="top start"
        popover={{
          offset: 4,
          collisionPadding: 8,
          className: "w-60 min-w-(--anchor-width) max-w-[calc(100vw-16px)]",
        }}
      >
        <MenuItem id="all" textValue="All calendars" onAction={() => pick(undefined)}>
          <IconCalendar data-slot="icon" />
          <Label name="All calendars" current={!shown} />
        </MenuItem>
        {calendars.map((calendar) => (
          <MenuItem
            key={calendar.id}
            id={calendar.id}
            textValue={nameOf(calendar)}
            onAction={() => pick(calendar.id)}
            className="ps-1.5 pe-1.5"
          >
            {face(calendar, 20)}
            <Label name={nameOf(calendar)} current={calendar.id === current} />
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}
