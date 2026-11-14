import type { ThreadSummary } from "@omni/client";
import { StyleSheet, View } from "react-native";
import { IconPaperclip, IconShared } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { listTime } from "@/lib/mail.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";

export interface ThreadRowProps {
  thread: ThreadSummary;
  /** The shared inbox this thread came in on, named; absent for your own mail. */
  sharedInbox?: string;
  onPress?: () => void;
}

/** One conversation in a list: who wrote last, when, the subject and the latest words. */
export function ThreadRow({ thread, sharedInbox, onPress }: ThreadRowProps) {
  const sender = thread.latestFrom?.name || thread.latestFrom?.address || "";
  const weight = thread.unread ? "semibold" : "regular";
  return (
    <PressableRow onPress={onPress} accessibilityHint={thread.unread ? "Unread" : undefined}>
      <Avatar name={sender} />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text weight={weight} numberOfLines={1} style={styles.grow}>
            {sender}
            {thread.messageCount > 1 ? (
              <Text size="sm" tone="mutedForeground" tabular>
                {`  ${thread.messageCount}`}
              </Text>
            ) : null}
          </Text>
          <Text
            size="sm"
            tone={thread.unread ? "foreground" : "mutedForeground"}
            weight={weight}
            tabular
          >
            {listTime(thread.lastMessageAt)}
          </Text>
        </View>
        <Text weight={weight} numberOfLines={1}>
          {thread.subject}
        </Text>
        <View style={styles.line}>
          <Text size="sm" tone="mutedForeground" numberOfLines={1} style={styles.grow}>
            {thread.snippet}
          </Text>
          {thread.hasAttachments ? (
            <IconPaperclip size={iconSize.sm} color={colors.mutedForeground} />
          ) : null}
          {sharedInbox ? (
            <View style={styles.inbox}>
              <IconShared size={iconSize.sm} color={colors.mutedForeground} />
              <Text size="sm" tone="mutedForeground" numberOfLines={1}>
                {sharedInbox}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: space(0.5) },
  line: { flexDirection: "row", alignItems: "center", gap: space(2) },
  grow: { flex: 1 },
  inbox: { flexDirection: "row", alignItems: "center", gap: space(1), maxWidth: "40%" },
});
