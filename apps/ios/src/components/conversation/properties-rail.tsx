import type { Thread } from "@omni/client";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { IconTag, IconUserRound } from "@/components/icons.ts";
import { MailboxAvatar } from "@/components/inbox/mailbox-avatar.tsx";
import { GhostButton } from "@/components/ui/ghost-button.tsx";
import { useAssignees, useConversation, type Conversation } from "@/lib/conversation.ts";
import { mailboxName, useMailboxes } from "@/lib/mail.ts";
import { useSession } from "@/lib/session.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";
import { LANES, LaneSheet } from "./lane-sheet.tsx";
import { Face, PRIORITY, PropertySheet, STATUS, type Sheet } from "./property-sheets.tsx";

/**
 * The conversation's properties under the top bar, as the desktop's properties row: its lane in
 * the brand's ink, the mailbox it came to (a tap opens that mailbox's inbox), and its tags; a shared inbox adds status, assignee
 * and priority. Each opens a sheet that changes it, as the web's menus do. Scrolls sideways
 * when it overflows.
 */
export function PropertiesRail({ thread }: { thread: Thread }) {
  const conversation = useConversation(thread.id, thread.mailboxKind === "shared").data;
  const [sheet, setSheet] = useState<Sheet | "lane" | null>(null);
  const lane = thread.triage ? LANES[thread.triage] : undefined;
  const tags = conversation?.tags.map((t) => t.name).join(", ");
  return (
    <View style={styles.rail}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="toolbar"
        accessibilityLabel="Properties"
        contentContainerStyle={styles.row}
      >
        {lane ? (
          <GhostButton
            icon={lane.icon}
            label={lane.label}
            tone="primary"
            accessibilityLabel={`Lane: ${lane.label}`}
            onPress={() => setSheet("lane")}
          />
        ) : null}
        <MailboxButton thread={thread} />
        {conversation ? (
          <SharedButtons thread={thread} conversation={conversation} onOpen={setSheet} />
        ) : null}
        <GhostButton
          icon={IconTag}
          label={tags || "Tags"}
          tone={tags ? "foreground" : "muted"}
          accessibilityLabel={tags ? `Tags: ${tags}` : "Tags"}
          onPress={conversation ? () => setSheet("tags") : undefined}
        />
      </ScrollView>
      <LaneSheet
        isOpen={sheet === "lane"}
        onClose={() => setSheet(null)}
        threadId={thread.id}
        lane={thread.triage}
      />
      {conversation ? (
        <PropertySheet
          sheet={sheet === "lane" ? null : sheet}
          onClose={() => setSheet(null)}
          thread={thread}
          conversation={conversation}
        />
      ) : null}
    </View>
  );
}

function MailboxButton({ thread }: { thread: Thread }) {
  const user = useSession().data?.user;
  const you = user?.name || user?.email || "";
  const mailbox = useMailboxes().data?.find((box) => box.id === thread.mailboxId);
  const face = mailbox ?? { address: thread.mailboxAddress, kind: thread.mailboxKind };
  const name = mailboxName(face, you);
  return (
    <GhostButton
      lead={<MailboxAvatar mailbox={face} name={name} size={iconSize.field} />}
      label={name}
      accessibilityLabel={`Mailbox: ${name}`}
      onPress={() =>
        router.dismissTo({
          pathname: "/mail",
          params: { page: "inbox", mailbox: thread.mailboxId },
        })
      }
    />
  );
}

function SharedButtons(props: {
  thread: Thread;
  conversation: Conversation;
  onOpen: (sheet: Sheet) => void;
}) {
  const { conversation, onOpen } = props;
  const assignees = useAssignees(props.thread.mailboxId, true).data ?? [];
  const status = STATUS[conversation.status];
  const priority = PRIORITY[conversation.priority];
  const assignee = assignees.find((a) => a.memberId === conversation.assigneeMemberId);
  const who = assignee?.name ?? "Unassigned";
  return (
    <>
      <GhostButton
        icon={status.icon}
        label={status.label}
        accessibilityLabel={`Status: ${status.label}`}
        onPress={() => onOpen("status")}
      />
      <GhostButton
        icon={assignee ? undefined : IconUserRound}
        lead={assignee ? <Face name={assignee.name} image={assignee.image} /> : undefined}
        label={who}
        accessibilityLabel={`Assignee: ${who}`}
        onPress={() => onOpen("assignee")}
      />
      <GhostButton
        icon={priority.icon}
        label={priority.label}
        accessibilityLabel={`Priority: ${priority.label}`}
        onPress={() => onOpen("priority")}
      />
    </>
  );
}

const styles = StyleSheet.create({
  rail: {
    height: space(13),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  row: { alignItems: "center", gap: space(1), paddingHorizontal: space(2.5) },
});
