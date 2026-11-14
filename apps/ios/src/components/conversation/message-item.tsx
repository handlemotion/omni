import type { Message } from "@omni/client";
import { StyleSheet, View } from "react-native";
import { IconPaperclip } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { listTime } from "@/lib/mail.ts";
import { colors, iconSize, radius, shadowRaised, space } from "@/theme/tokens.ts";

export interface MessageItemProps {
  message: Message;
  onShowFull?: () => void;
}

/**
 * One message as the spec draws it: who and when, then only what they newly wrote. Short ones are
 * bubbles (yours and your team's on the right, tinted), long or formal ones cards (`display`,
 * decided by the Worker). With HTML, "Show full message" opens the original.
 */
export function MessageItem({ message, onShowFull }: MessageItemProps) {
  const sender = message.fromName || message.fromAddress;
  const ours = message.fromTeam;
  const card = message.display === "card";
  return (
    <View style={[styles.item, ours && !card && styles.ours]}>
      <View style={[styles.meta, ours && !card && styles.oursMeta]}>
        <Avatar name={sender} size={24} />
        <Text size="sm" weight="medium" numberOfLines={1} style={styles.shrink}>
          {sender}
        </Text>
        <Text size="sm" tone="mutedForeground" tabular>
          {listTime(message.sentAt)}
        </Text>
      </View>
      <View style={card ? styles.card : [styles.bubble, ours && styles.oursBubble]}>
        <Text selectable>{message.cleanText}</Text>
      </View>
      {message.attachments.length ? (
        <View style={[styles.attachments, ours && !card && styles.oursMeta]}>
          {message.attachments.map((file) => (
            <View key={file.id} style={styles.chip}>
              <IconPaperclip size={iconSize.sm} color={colors.mutedForeground} />
              <Text size="sm" numberOfLines={1} style={styles.shrink}>
                {file.filename}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {message.hasHtml && onShowFull ? (
        <Button
          intent="quiet"
          label="Show full message"
          onPress={onShowFull}
          style={ours && !card ? styles.oursAction : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { gap: space(2), alignItems: "flex-start" },
  ours: { alignItems: "flex-end" },
  meta: { flexDirection: "row", alignItems: "center", gap: space(2), maxWidth: "100%" },
  oursMeta: { justifyContent: "flex-end" },
  shrink: { flexShrink: 1 },
  bubble: {
    maxWidth: "85%",
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
    borderRadius: radius.card,
    backgroundColor: colors.accent,
  },
  oursBubble: { backgroundColor: colors.primarySubtle },
  card: {
    alignSelf: "stretch",
    padding: space(4),
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadowRaised,
  },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: space(2), maxWidth: "100%" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    maxWidth: 220,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  oursAction: { alignSelf: "flex-end" },
});
