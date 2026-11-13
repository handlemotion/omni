// A shared inbox's helpdesk list (one view: Unassigned, Mine, Open, ...): the thread list's rows
// with each conversation's status, tags, priority, SLA clock and assignee, a bar for acting on
// the selected rows, and the empty and failed states.
import { useMemo, useRef, type ReactNode } from "react";
import { getLocalTimeZone, today } from "@internationalized/date";
import type { DateValue } from "react-aria-components/Calendar";
import {
  IconCheck,
  IconCircleCheck,
  IconClock3,
  IconPlus,
  IconUserCog,
} from "@/components/icons/central";
import { IconClock } from "@/components/icons/sidebar";
import { viewLabel } from "@/components/shell/helpdesk-nav";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { createPopoverController, Popover, PopoverRoot } from "@/components/ui/popover";
import {
  useAssignees,
  useConversationChanges,
  useConversations,
  useTags,
} from "@/hooks/use-conversation.ts";
import { runShortcut } from "@/hooks/use-shortcuts.ts";
import { useUndo } from "@/hooks/use-undo.ts";
import { inverseOf, type ConversationChange } from "@/lib/conversations.ts";
import { senderLabel } from "@/lib/threads.ts";
import type { ConversationFilter, ConversationSummary } from "@/lib/types.ts";
import { offerUndo } from "@/lib/undo.ts";
import type { ConversationRowInfo } from "./conversation-meta";
import { EmptyState } from "@/components/empty/empty-state";
import { List, ListFailed, type ListRow } from "./thread-list";

/** Views whose rows can be in more than one status, so each row says which. */
const MIXED = new Set<ConversationFilter["view"]>(["mine", "all"]);

export function ConversationList(props: {
  filter: ConversationFilter;
  href: (threadId: string) => string;
  children?: ReactNode;
}) {
  const { filter } = props;
  const query = useConversations(filter);
  const { conversations, hasNextPage, fetchNextPage, isFetchingNextPage } = query;
  const assignees = useAssignees(filter.mailbox).data;
  const rows = useMemo(() => {
    const people = new Map(assignees?.map((a) => [a.memberId, a]));
    return conversations.map((c): ListRow => {
      const assignee = c.assigneeMemberId ? people.get(c.assigneeMemberId) : undefined;
      const info: ConversationRowInfo = {
        status: MIXED.has(filter.view) ? c.status : undefined,
        priority: c.priority,
        tags: c.tags,
        // Only open conversations run against an SLA: pending waits on the customer.
        slaDueAt: c.status === "open" ? c.slaDueAt : null,
        hasAttachments: c.hasAttachments,
        assignee: assignee ? { name: assignee.name, image: assignee.image } : null,
        lastMessageAt: c.lastMessageAt,
      };
      return {
        id: c.id,
        sender: senderLabel(c),
        subject: c.subject,
        snippet: c.snippet,
        unread: c.unread,
        conversation: info,
      };
    });
  }, [conversations, assignees, filter.view]);
  const loadMore = useMemo(
    () => (hasNextPage ? () => void fetchNextPage() : undefined),
    [hasNextPage, fetchNextPage],
  );
  const title = viewLabel(filter.view);

  return (
    <List
      title={title}
      href={props.href}
      rows={rows}
      loading={query.isPending}
      caption={filter.view === "sla_at_risk" ? "Soonest due" : undefined}
      shortcuts={{ view: "inbox", threads: [], loadMore, helpdesk: { filter, conversations } }}
      loadMore={loadMore}
      isLoadingMore={isFetchingNextPage}
      bulkActions={({ ids, clear }) => (
        <BulkActions
          filter={filter}
          rows={conversations.filter((c) => ids.includes(c.id))}
          clear={clear}
        />
      )}
      empty={
        query.isError ? (
          <ListFailed retry={() => void query.refetch()} />
        ) : query.isSuccess ? (
          <EmptyState figure="drawer" title={EMPTY_TEXT[filter.view]} />
        ) : undefined
      }
    >
      {props.children}
    </List>
  );
}

const EMPTY_TEXT: Record<ConversationFilter["view"], string> = {
  unassigned: "Nothing waiting for an owner",
  mine: "Nothing assigned to you",
  open: "No open conversations",
  pending: "Nothing waiting on a customer",
  snoozed: "Nothing snoozed",
  resolved: "Nothing resolved yet",
  sla_at_risk: "No SLA due soon",
  all: "No conversations",
};

/** Tomorrow and next Monday at 8:00, and later today (3 hours on): where a snooze usually goes. */
function snoozePresets(now = new Date()) {
  const at8 = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(8, 0, 0, 0);
    return d;
  };
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { id: "later", label: "Later today", until: new Date(now.getTime() + 3 * 3_600_000) },
    { id: "tomorrow", label: "Tomorrow", until: at8(1) },
    { id: "week", label: "Next week", until: at8(toMonday) },
  ];
}

const plural = (n: number) => (n === 1 ? "Conversation" : `${n} conversations`);

/**
 * The selected rows' actions. Resolve and assign to me run the list's own `e` and `i`, so the
 * bar and the keys do one thing; snooze to a chosen time and tags apply one change per row with
 * one undo for the batch.
 */
function BulkActions(props: {
  filter: ConversationFilter;
  rows: ConversationSummary[];
  clear: () => void;
}) {
  const { filter, rows, clear } = props;
  const changes = useConversationChanges();
  const tags = useTags(filter.mailbox).data ?? [];
  useUndo();
  const resolved = rows.length > 0 && rows.every((r) => r.status === "resolved");

  const apply = (make: (row: ConversationSummary) => ConversationChange, said: string) => {
    const batch = rows.map((row) => ({ row, change: make(row) }));
    for (const { row, change } of batch) {
      // An added tag shows at once only when the whole tag rides along.
      const tag = change.type === "tag" ? tags.find((t) => t.id === change.tagId) : undefined;
      changes.run(row.id, change, { undo: false, tag, mailboxId: filter.mailbox });
    }
    clear();
    offerUndo(said, () => {
      for (const { row, change } of batch) {
        const inverse = inverseOf(row, change);
        const tag =
          inverse?.type === "tag" ? row.tags.find((t) => t.id === inverse.tagId) : undefined;
        if (inverse) changes.run(row.id, inverse, { undo: false, tag, mailboxId: filter.mailbox });
      }
    });
  };
  const snooze = (until: Date) =>
    apply(() => ({ type: "snooze", until: until.toISOString() }), `${plural(rows.length)} snoozed`);
  // "Pick a date" closes the menu and opens the calendar under the Snooze button: a calendar is
  // not a menu item, so it lives in its own popover instead of a submenu.
  const pickDate = useMemo(() => createPopoverController(), []);
  const snoozeButton = useRef<HTMLButtonElement>(null);
  const pickDay = (day: DateValue) => {
    pickDate.close();
    snooze(new Date(day.year, day.month - 1, day.day, 8, 0, 0, 0));
  };

  return (
    <div className="flex items-center gap-1">
      <span className="me-2 translate-y-px text-xs text-subtle-foreground tabular-nums">
        {rows.length} selected
      </span>
      <Button intent="plain" size="sm" onPress={() => runShortcut("assignToMe")}>
        <IconUserCog />
        Assign to me
      </Button>
      <Button intent="plain" size="sm" onPress={() => runShortcut("resolve")}>
        <IconCircleCheck />
        {resolved ? "Reopen" : "Resolve"}
      </Button>
      <MenuTrigger>
        <Button ref={snoozeButton} intent="plain" size="sm">
          <IconClock />
          Snooze
        </Button>
        <Menu placement="bottom start">
          {snoozePresets().map((preset) => (
            <MenuItem
              key={preset.id}
              textValue={preset.label}
              onAction={() => snooze(preset.until)}
            >
              <IconClock3 data-slot="icon" />
              <MenuLabel>{preset.label}</MenuLabel>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
            textValue="Pick a date"
            onAction={() => void pickDate.open({ anchor: snoozeButton.current ?? undefined })}
          >
            <IconClock3 data-slot="icon" />
            <MenuLabel>Pick a date</MenuLabel>
          </MenuItem>
        </Menu>
      </MenuTrigger>
      <PopoverRoot controller={pickDate}>
        <Popover placement="bottom start" aria-label="Snooze until" className="p-2">
          <Calendar
            aria-label="Snooze until"
            minValue={today(getLocalTimeZone()).add({ days: 1 })}
            onChange={pickDay}
          />
        </Popover>
      </PopoverRoot>
      {tags.length > 0 && (
        <MenuTrigger>
          <Button intent="plain" size="sm">
            Tag
          </Button>
          <Menu placement="bottom start">
            {tags.map((tag) => {
              const all = rows.every((r) => r.tags.some((t) => t.id === tag.id));
              return (
                <MenuItem
                  key={tag.id}
                  textValue={tag.name}
                  onAction={() =>
                    apply(
                      () => ({ type: "tag", tagId: tag.id, add: !all }),
                      all ? `Removed ${tag.name}` : `Tagged ${tag.name}`,
                    )
                  }
                >
                  {all ? <IconCheck data-slot="icon" /> : <IconPlus data-slot="icon" />}
                  <MenuLabel>{tag.name}</MenuLabel>
                </MenuItem>
              );
            })}
          </Menu>
        </MenuTrigger>
      )}
    </div>
  );
}
