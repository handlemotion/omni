import type { Thread } from "@omni/client";
import type { ComponentType } from "react";
import type { SvgProps } from "react-native-svg";
import {
  IconCheck,
  IconCircle,
  IconCircleCheck,
  IconCircleDashed,
  IconClock,
  IconSignalHigh,
  IconSignalLow,
  IconSignalMedium,
  IconTag,
  IconUserRound,
  IconWarning,
} from "@/components/icons.ts";
import { MenuRow } from "@/components/shell/menu-row.tsx";
import { Avatar } from "@/components/ui/avatar.tsx";
import { BottomSheet } from "@/components/ui/bottom-sheet.tsx";
import {
  useAssignees,
  useConversationChange,
  useTags,
  type Conversation,
  type ConversationStatus,
  type Priority,
} from "@/lib/conversation.ts";
import { usePictureSource } from "@/lib/picture.ts";
import { colors, iconSize } from "@/theme/tokens.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;

export type Sheet = "status" | "assignee" | "priority" | "tags";

/** A conversation snoozed before Snooze was retired still reads as such until it wakes. */
export const STATUS: Record<ConversationStatus, { label: string; icon: Glyph }> = {
  open: { label: "Open", icon: IconCircle },
  pending: { label: "Pending", icon: IconCircleDashed },
  snoozed: { label: "Snoozed", icon: IconClock },
  resolved: { label: "Resolved", icon: IconCircleCheck },
};

export const PRIORITY: Record<Priority, { label: string; icon: Glyph }> = {
  urgent: { label: "Urgent", icon: IconWarning },
  high: { label: "High", icon: IconSignalHigh },
  normal: { label: "Normal", icon: IconSignalMedium },
  low: { label: "Low", icon: IconSignalLow },
};
const PRIORITIES = Object.keys(PRIORITY) as Priority[];

const TITLES: Record<Sheet, string> = {
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  tags: "Tags",
};

const check = <IconCheck size={iconSize.md} color={colors.foreground} />;

/**
 * The sheet a property opens, with the web menu's choices: its status (reopen or resolve), who
 * it's assigned to, its priority, or its tags (each tap adds or removes one; the sheet stays).
 */
export function PropertySheet(props: {
  sheet: Sheet | null;
  onClose: () => void;
  thread: Thread;
  conversation: Conversation;
}) {
  const { sheet, conversation } = props;
  const change = useConversationChange(props.thread.id);
  const assignees = useAssignees(props.thread.mailboxId, true).data ?? [];
  const tags = useTags(props.thread.mailboxId, true).data ?? [];
  const then = (run: () => void) => () => {
    props.onClose();
    run();
  };
  const applied = new Set(conversation.tags.map((t) => t.id));
  return (
    <BottomSheet isOpen={sheet !== null} onClose={props.onClose} title={sheet ? TITLES[sheet] : ""}>
      {sheet === "status" ? (
        <>
          {conversation.status === "open" ? null : (
            <MenuRow
              icon={IconCircle}
              muted
              label="Reopen"
              onPress={then(() => change({ type: "reopen" }))}
            />
          )}
          {conversation.status === "resolved" ? null : (
            <MenuRow
              icon={IconCircleCheck}
              muted
              label="Resolve"
              onPress={then(() => change({ type: "resolve" }))}
            />
          )}
        </>
      ) : null}
      {sheet === "assignee" ? (
        <>
          <MenuRow
            icon={IconUserRound}
            muted
            label="Unassigned"
            trailing={conversation.assigneeMemberId ? undefined : check}
            onPress={then(() => change({ type: "assign", memberId: null }))}
          />
          {assignees.map((a) => (
            <MenuRow
              key={a.memberId}
              lead={<Face name={a.name} image={a.image} size={iconSize.menu} />}
              label={a.name}
              trailing={a.memberId === conversation.assigneeMemberId ? check : undefined}
              onPress={then(() => change({ type: "assign", memberId: a.memberId }))}
            />
          ))}
        </>
      ) : null}
      {sheet === "priority"
        ? PRIORITIES.map((p) => (
            <MenuRow
              key={p}
              icon={PRIORITY[p].icon}
              muted
              label={PRIORITY[p].label}
              trailing={p === conversation.priority ? check : undefined}
              onPress={then(() => change({ type: "priority", priority: p }))}
            />
          ))
        : null}
      {sheet === "tags"
        ? tags.map((tag) => (
            <MenuRow
              key={tag.id}
              icon={IconTag}
              muted
              label={tag.name}
              trailing={applied.has(tag.id) ? check : undefined}
              onPress={() => change({ type: "tag", tag, add: !applied.has(tag.id) })}
            />
          ))
        : null}
    </BottomSheet>
  );
}

/** A teammate's picture or initial, at the glyph's size. */
export function Face({
  name,
  image,
  size = iconSize.field,
}: {
  name: string;
  image: string | null;
  size?: number;
}) {
  const photo = usePictureSource(image);
  return <Avatar name={name} photo={photo} size={size} />;
}
