import type { ComponentType } from "react";
import {
  IconCircle,
  IconCircleCheck,
  IconCircleDashed,
  IconClock3,
  IconSignalHigh,
  IconSignalLow,
  IconSignalMedium,
  IconTag,
  IconTriangleAlert,
  IconUserRound,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import {
  useAssign,
  useAssignees,
  useConversation,
  useReopen,
  useResolve,
  useSetPriority,
  useSnooze,
  useTags,
  useToggleTag,
} from "@/hooks/use-conversation.ts";
import type { Assignee, ConversationStatus, Priority, Thread } from "@/lib/types.ts";
import { pictureUrl } from "@/lib/urls.ts";

/** Under 34rem of toolbar the labels hide and each control is a 28px square, like the actions. */
const ICON_ONLY = "@max-[34rem]:w-7 @max-[34rem]:px-0";

type Glyph = ComponentType<{ className?: string; "data-slot"?: string }>;

const STATUS: Record<ConversationStatus, { label: string; icon: Glyph }> = {
  open: { label: "Open", icon: IconCircle },
  pending: { label: "Pending", icon: IconCircleDashed },
  snoozed: { label: "Snoozed", icon: IconClock3 },
  resolved: { label: "Resolved", icon: IconCircleCheck },
};

const PRIORITY: Record<Priority, { label: string; icon: Glyph }> = {
  urgent: { label: "Urgent", icon: IconTriangleAlert },
  high: { label: "High", icon: IconSignalHigh },
  normal: { label: "Normal", icon: IconSignalMedium },
  low: { label: "Low", icon: IconSignalLow },
};
const PRIORITIES = Object.keys(PRIORITY) as Priority[];

/** 8am local, `days` from today. */
function morning(days: number) {
  const at = new Date();
  at.setDate(at.getDate() + days);
  at.setHours(8, 0, 0, 0);
  return at;
}
/** Days until next Monday (a full week on a Monday). */
const untilMonday = () => (8 - new Date().getDay()) % 7 || 7;

/** The snooze choices, in the status menu and the reader's Snooze. */
export const SNOOZES = [
  { label: "Snooze until tomorrow", until: () => morning(1) },
  { label: "Snooze until Monday", until: () => morning(untilMonday()) },
];

/**
 * A shared inbox's conversation state, at the left of the reader's toolbar: status, assignee,
 * priority and tags, each a menu. Every change shows at once and offers undo.
 */
export function Properties({ thread }: { thread: Thread }) {
  const { data: conversation } = useConversation(thread.id);
  const { data: assignees = [] } = useAssignees(thread.mailboxId);
  const { data: tags = [] } = useTags(thread.mailboxId);
  const resolve = useResolve();
  const reopen = useReopen();
  const snooze = useSnooze();
  const assign = useAssign();
  const setPriority = useSetPriority();
  const toggleTag = useToggleTag();
  if (!conversation) return null;

  const threadId = thread.id;
  const status = STATUS[conversation.status];
  const priority = PRIORITY[conversation.priority];
  const assignee = assignees.find((a) => a.memberId === conversation.assigneeMemberId);
  const applied = new Set(conversation.tags.map((t) => t.id));

  return (
    // Pulled left by the buttons' own inset (10px, or 6.5px once they are icon squares), so the
    // first icon starts at the column's edge. The cap keeps its right edge 8px clear of the
    // toolbar's actions (130px, out of the flow): the column is centred, so its left edge sits
    // at (toolbar - column) / 2 + 10px. Long names and tags truncate instead of sliding under.
    <div className="-ms-2.5 flex max-w-[calc(50cqw+min(50cqw,24rem)-9.25rem)] min-w-0 items-center gap-1 @max-[34rem]:-ms-[6.5px]">
      <MenuTrigger>
        <Button
          intent="ghost"
          size="sm"
          className={ICON_ONLY}
          aria-label={`Status: ${status.label}`}
        >
          <status.icon />
          <span className="hidden @[34rem]:inline">{status.label}</span>
        </Button>
        <Menu placement="bottom start">
          {/* Snoozed and pending conversations can go straight back to Open. */}
          {conversation.status !== "open" && (
            <Item icon={IconCircle} label="Reopen" onAction={() => reopen.mutate({ threadId })} />
          )}
          {conversation.status !== "resolved" && (
            <Item
              icon={IconCircleCheck}
              label="Resolve"
              onAction={() => resolve.mutate({ threadId })}
            />
          )}
          <MenuSeparator />
          {SNOOZES.map(({ label, until }) => (
            <Item
              key={label}
              icon={IconClock3}
              label={label}
              onAction={() => snooze.mutate({ threadId, until: until() })}
            />
          ))}
        </Menu>
      </MenuTrigger>

      <MenuTrigger>
        <Button
          intent="ghost"
          size="sm"
          aria-label={`Assignee: ${assignee?.name ?? "Unassigned"}`}
          className={`min-w-0 ${ICON_ONLY}`}
        >
          {assignee ? <Face assignee={assignee} /> : <IconUserRound />}
          <span className="hidden truncate @[34rem]:inline">{assignee?.name ?? "Unassigned"}</span>
        </Button>
        <Menu
          placement="bottom start"
          selectionMode="single"
          selectedKeys={[conversation.assigneeMemberId ?? "none"]}
        >
          <MenuItem
            id="none"
            textValue="Unassigned"
            onAction={() => assign.mutate({ threadId, memberId: null })}
          >
            <IconUserRound data-slot="icon" />
            <MenuLabel>Unassigned</MenuLabel>
          </MenuItem>
          {assignees.map((a) => (
            <MenuItem
              key={a.memberId}
              id={a.memberId}
              textValue={a.name}
              onAction={() => assign.mutate({ threadId, memberId: a.memberId })}
            >
              <Face assignee={a} />
              <MenuLabel>{a.name}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>

      <MenuTrigger>
        <Button
          intent="ghost"
          size="sm"
          className={ICON_ONLY}
          aria-label={`Priority: ${priority.label}`}
        >
          <priority.icon />
          <span className="hidden @[34rem]:inline">{priority.label}</span>
        </Button>
        <Menu
          placement="bottom start"
          selectionMode="single"
          selectedKeys={[conversation.priority]}
        >
          {PRIORITIES.map((p) => {
            const { label, icon: Icon } = PRIORITY[p];
            return (
              <MenuItem
                key={p}
                id={p}
                textValue={label}
                onAction={() => setPriority.mutate({ threadId, priority: p })}
              >
                <Icon data-slot="icon" />
                <MenuLabel>{label}</MenuLabel>
              </MenuItem>
            );
          })}
        </Menu>
      </MenuTrigger>

      <MenuTrigger>
        <Button
          intent="ghost"
          size="sm"
          aria-label={
            conversation.tags.length
              ? `Tags: ${conversation.tags.map((t) => t.name).join(", ")}`
              : "Add tags"
          }
          className={`min-w-0 ${ICON_ONLY}`}
        >
          <IconTag />
          <span className="hidden truncate @[34rem]:inline">
            {conversation.tags.length ? conversation.tags.map((t) => t.name).join(", ") : "Tags"}
          </span>
        </Button>
        <Menu
          placement="bottom start"
          selectionMode="multiple"
          selectedKeys={[...applied]}
          // The new selection, compared with what is applied now: a per-item handler would keep
          // the `applied` set from when React Aria first rendered that item.
          onSelectionChange={(keys) => {
            const next = keys === "all" ? new Set(tags.map((t) => t.id)) : keys;
            for (const tag of tags) {
              if (next.has(tag.id) !== applied.has(tag.id)) {
                toggleTag.mutate({ threadId, tag, add: next.has(tag.id) });
              }
            }
          }}
          items={tags}
          renderEmptyState={() => (
            <p className="px-3 py-2 text-sm text-muted-foreground">No tags in this inbox yet</p>
          )}
        >
          {(tag) => (
            <MenuItem id={tag.id} textValue={tag.name}>
              <IconTag data-slot="icon" />
              <MenuLabel>{tag.name}</MenuLabel>
            </MenuItem>
          )}
        </Menu>
      </MenuTrigger>
    </div>
  );
}

function Item(props: { icon: Glyph; label: string; onAction: () => void }) {
  return (
    <MenuItem textValue={props.label} onAction={props.onAction}>
      <props.icon data-slot="icon" />
      <MenuLabel>{props.label}</MenuLabel>
    </MenuItem>
  );
}

function Face({ assignee }: { assignee: Assignee }) {
  return (
    <Avatar
      data-slot="avatar"
      size="xs"
      src={pictureUrl(assignee.image)}
      initials={assignee.name.slice(0, 1).toUpperCase()}
      className="size-4 [--avatar-size:--spacing(4)]"
    />
  );
}
