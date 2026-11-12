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
} from "@/components/icons/lucide";
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
    <div className="flex min-w-0 items-center gap-1">
      <MenuTrigger>
        <Button intent="ghost" size="sm" aria-label={`Status: ${status.label}`}>
          <status.icon />
          {status.label}
        </Button>
        <Menu placement="bottom start">
          {conversation.status === "resolved" ? (
            <Item icon={IconCircle} label="Reopen" onAction={() => reopen.mutate({ threadId })} />
          ) : (
            <Item
              icon={IconCircleCheck}
              label="Resolve"
              onAction={() => resolve.mutate({ threadId })}
            />
          )}
          <MenuSeparator />
          <Item
            icon={IconClock3}
            label="Snooze until tomorrow"
            onAction={() => snooze.mutate({ threadId, until: morning(1) })}
          />
          <Item
            icon={IconClock3}
            label="Snooze until Monday"
            onAction={() => snooze.mutate({ threadId, until: morning(untilMonday()) })}
          />
        </Menu>
      </MenuTrigger>

      <MenuTrigger>
        <Button
          intent="ghost"
          size="sm"
          aria-label={`Assignee: ${assignee?.name ?? "Unassigned"}`}
          className="min-w-0"
        >
          {assignee ? <Face assignee={assignee} /> : <IconUserRound />}
          <span className="truncate">{assignee?.name ?? "Unassigned"}</span>
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
        <Button intent="ghost" size="sm" aria-label={`Priority: ${priority.label}`}>
          <priority.icon />
          {priority.label}
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
          className="min-w-0"
        >
          <IconTag />
          <span className="truncate">
            {conversation.tags.length ? conversation.tags.map((t) => t.name).join(", ") : "Tags"}
          </span>
        </Button>
        <Menu
          placement="bottom start"
          selectionMode="multiple"
          selectedKeys={[...applied]}
          items={tags}
          renderEmptyState={() => (
            <p className="px-3 py-2 text-sm text-muted-foreground">No tags in this inbox yet</p>
          )}
        >
          {(tag) => (
            <MenuItem
              id={tag.id}
              textValue={tag.name}
              onAction={() => toggleTag.mutate({ threadId, tag, add: !applied.has(tag.id) })}
            >
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
