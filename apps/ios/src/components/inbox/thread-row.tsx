import { StyleSheet, View } from "react-native";
import { IconPaperclip, IconShared } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { PressableRow, type PressableRowProps } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { listTime } from "@/lib/mail.ts";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

/** What a row shows of a thread: a list's summary or a search hit. */
export interface ThreadRowData {
  sender: string;
  senderAddress?: string | null;
  subject: string;
  snippet: string;
  unread: boolean;
  lastMessageAt: string;
  messageCount?: number;
  hasAttachments?: boolean;
}

export interface ThreadRowProps extends Omit<PressableRowProps, "children"> {
  thread: ThreadRowData;
  /** The shared inbox this thread came in on, named; absent for your own mail. */
  sharedInbox?: string;
}

/**
 * One conversation in a list: who wrote last and when, the subject, two lines of what they said.
 * Each line truncates on its own; the time, count and marks keep their room.
 */
export function ThreadRow({ thread, sharedInbox, ...props }: ThreadRowProps) {
  const weight = thread.unread ? "semibold" : "regular";
  const count = thread.messageCount ?? 1;
  return (
    <PressableRow
      {...props}
      accessibilityLabel={[
        thread.unread ? "Unread" : null,
        thread.sender,
        thread.subject,
        listTime(thread.lastMessageAt),
      ]
        .filter(Boolean)
        .join(", ")}
    >
      <Avatar
        name={thread.sender}
        logo={thread.senderAddress ? { address: thread.senderAddress } : null}
      />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text weight={weight} numberOfLines={1} style={styles.shrink}>
            {thread.sender || " "}
          </Text>
          {count > 1 ? (
            <Text size="sm" tone="mutedForeground" tabular style={styles.keep}>
              {count}
            </Text>
          ) : null}
          <View style={styles.grow} />
          {thread.unread ? <View style={styles.dot} /> : null}
          <Text
            size="sm"
            tone={thread.unread ? "foreground" : "mutedForeground"}
            tabular
            style={styles.keep}
          >
            {listTime(thread.lastMessageAt)}
          </Text>
        </View>
        <Text size="sm" weight={thread.unread ? "medium" : "regular"} numberOfLines={1}>
          {thread.subject || " "}
        </Text>
        <View style={styles.line}>
          <Text size="sm" tone="mutedForeground" numberOfLines={2} style={styles.grow}>
            {thread.snippet}
          </Text>
          {thread.hasAttachments || sharedInbox ? (
            <View style={styles.marks}>
              {thread.hasAttachments ? (
                <IconPaperclip size={iconSize.sm} color={colors.mutedForeground} />
              ) : null}
              {sharedInbox ? (
                <View style={styles.inbox}>
                  <IconShared size={iconSize.sm} color={colors.mutedForeground} />
                  <Text size="xs" tone="mutedForeground" numberOfLines={1} style={styles.shrink}>
                    {sharedInbox}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, minWidth: 0, gap: space(0.5) },
  line: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  keep: { flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.primary },
  marks: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space(1.5),
    maxWidth: "45%",
    paddingTop: space(0.5),
  },
  inbox: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: space(2),
    paddingVertical: space(0.5),
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
});
