import { cn } from "cn";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { GridList, GridListHeader, GridListItem, GridListSection } from "@/components/ui/grid-list";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { mailboxName } from "@/components/shell/mailbox-switcher";
import { useCalendars, useCalendarWrites } from "@/hooks/use-calendar.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import { calendarTone, type CalendarItem } from "@/lib/calendar.ts";

const DOTS = 3;

function Dot({ tone, className }: { tone: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2.5 shrink-0 rounded-full", className)}
      style={{ background: tone }}
    />
  );
}

function byAccount(calendars: readonly CalendarItem[]) {
  const groups = new Map<string, CalendarItem[]>();
  for (const calendar of calendars) {
    groups.set(calendar.address, [...(groups.get(calendar.address) ?? []), calendar]);
  }
  return [...groups];
}

function useCalendarName() {
  const { user, member } = useMember();
  const workspaces = useWorkspaces();
  const mailboxes =
    workspaces.data?.workspaces.find((workspace) => workspace.id === member.orgId)?.mailboxes ?? [];
  const you = user.name || user.email;
  return (calendar: CalendarItem) => {
    if (calendar.name) return calendar.name;
    const box = mailboxes.find((mailbox) => mailbox.id === calendar.mailboxId);
    return box ? mailboxName(box, you) : calendar.address;
  };
}

/** Which calendars the grid lays over each other, in the page's header, grouped by account. */
export function CalendarFilter() {
  const calendars = useCalendars().data ?? [];
  const { prefs } = useCalendarWrites();
  const nameOf = useCalendarName();
  const [query, setQuery] = useState("");
  if (calendars.length === 0) return null;
  const shown = calendars.filter((calendar) => !calendar.hidden);
  const label = `${shown.length} ${shown.length === 1 ? "calendar" : "calendars"}`;
  const needle = query.trim().toLowerCase();
  const matching = calendars.filter(
    (calendar) =>
      !needle ||
      nameOf(calendar).toLowerCase().includes(needle) ||
      calendar.address.toLowerCase().includes(needle),
  );
  const toggle = (keys: "all" | Set<unknown>) => {
    for (const calendar of matching) {
      const hidden = keys !== "all" && !keys.has(calendar.id);
      if (hidden !== calendar.hidden) prefs.mutate({ id: calendar.id, hidden });
    }
  };
  return (
    <PopoverTrigger onOpenChange={(open) => !open && setQuery("")}>
      <Button intent="outline" size="sm" aria-label={`Calendars, ${label} shown`}>
        {shown.length > 0 && (
          <span className="flex items-center -space-x-0.5">
            {shown.slice(0, DOTS).map((calendar) => (
              <Dot
                key={calendar.id}
                tone={calendarTone(calendars, calendar.id)}
                className="ring-1 ring-(--btn-bg) in-hover:ring-(--btn-overlay) in-aria-expanded:ring-(--btn-overlay)"
              />
            ))}
          </span>
        )}
        <span className="tabular-nums">{label}</span>
      </Button>
      <Popover
        aria-label="Calendars"
        placement="bottom end"
        offset={9}
        className="w-72 max-w-[calc(100vw-16px)] overflow-hidden"
      >
        <SearchField
          aria-label="Filter calendars"
          value={query}
          onChange={setQuery}
          autoFocus
          className="border-b px-4"
        >
          <Input
            plain
            size="lg"
            placeholder={`Filter ${calendars.length} ${calendars.length === 1 ? "calendar" : "calendars"}…`}
          />
        </SearchField>
        <GridList
          aria-label="Calendars"
          selectionMode="multiple"
          selectionBehavior="toggle"
          selectedKeys={shown.map((calendar) => calendar.id)}
          onSelectionChange={toggle}
          className="min-h-0 flex-1 overflow-y-auto bg-transparent px-1 pb-2"
        >
          {byAccount(matching).map(([address, group]) => (
            <GridListSection key={address} className="divide-y-0">
              <GridListHeader className="truncate px-3 pt-4 pb-2.5 text-xs/4 text-muted-foreground">
                {address}
              </GridListHeader>
              {group.map((calendar) => (
                <GridListItem
                  key={calendar.id}
                  id={calendar.id}
                  textValue={nameOf(calendar)}
                  className="h-7.5 gap-2.5 rounded-sm px-2.5 hover:bg-accent focus-visible:bg-accent"
                >
                  <Dot tone={calendarTone(calendars, calendar.id)} />
                  <span className="min-w-0 truncate">{nameOf(calendar)}</span>
                </GridListItem>
              ))}
            </GridListSection>
          ))}
        </GridList>
      </Popover>
    </PopoverTrigger>
  );
}
