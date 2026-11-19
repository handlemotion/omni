import { StyleSheet, View } from "react-native";
import { IconPaperclip, IconShared } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { PressableRow, type PressableRowProps } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { listTime } from "@/lib/mail.ts";
import { colors, iconSize, radius, space, unreadDot } from "@/theme/tokens.ts";

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
 * One conversation in a list, as Spark draws it: the sender's logo, then who wrote last (a blue
 * dot after the name when unread), the subject, and one line of what they said ending in when.
 * With nothing said, the subject line ends in when, and the row keeps to two lines. Each line
 * truncates on its own; the time, count and marks keep their room.
 */
export function ThreadRow({ thread, sharedInbox, ...props }: ThreadRowProps) {
  const weight = thread.unread ? "medium" : "regular";
  const snippet = thread.snippet.trim();
  return (
    <PressableRow
      {...props}
      style={styles.row}
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
        shape="square"
      />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text size="subhead" weight={weight} numberOfLines={1} style={styles.shrink}>
            {thread.sender || " "}
          </Text>
          {thread.unread ? <View style={styles.dot} /> : null}
        </View>
        {snippet ? (
          <>
            <Text size="subhead" weight={weight} numberOfLines={1}>
              {thread.subject || " "}
            </Text>
            <View style={styles.line}>
              <Text size="subhead" tone="mutedForeground" numberOfLines={1} style={styles.grow}>
                {snippet}
              </Text>
              <Trail thread={thread} sharedInbox={sharedInbox} />
            </View>
          </>
        ) : (
          <View style={styles.line}>
            <Text size="subhead" weight={weight} numberOfLines={1} style={styles.grow}>
              {thread.subject || " "}
            </Text>
            <Trail thread={thread} sharedInbox={sharedInbox} />
          </View>
        )}
      </View>
    </PressableRow>
  );
}

function Trail({ thread, sharedInbox }: Pick<ThreadRowProps, "thread" | "sharedInbox">) {
  const count = thread.messageCount ?? 1;
  return (
    <>
      {count > 1 ? (
        <Text size="caption" weight="medium" tone="mutedForeground" tabular style={styles.keep}>
          {count}
        </Text>
      ) : null}
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
      <Text size="caption" weight="medium" tone="mutedForeground" tabular style={styles.keep}>
        {listTime(thread.lastMessageAt)}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  row: { gap: space(3), paddingVertical: space(4), alignItems: "flex-start" },
  body: { flex: 1, minWidth: 0, gap: space(0.5) },
  dot: {
    flexShrink: 0,
    width: unreadDot,
    height: unreadDot,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
  },
  line: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  keep: { flexShrink: 0 },
  marks: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    maxWidth: "45%",
  },
  inbox: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: space(1.5),
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
});
