import type { Message } from "@omni/client";
import { StyleSheet, View } from "react-native";
import { IconPaperclip } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { listTime } from "@/lib/mail.ts";
import { colors, iconSize, radius, shadowRaised, space } from "@/theme/tokens.ts";

export interface MessageItemProps {
  message: Message;
  onShowFull?: () => void;
  onOpenAttachment?: (file: Message["attachments"][number]) => void;
}

/**
 * One message as the spec draws it: who and when, then only what they newly wrote. Short ones are
 * bubbles (yours and your team's on the right, tinted), long or formal ones cards (`display`,
 * decided by the Worker). With HTML, "Show full message" opens the original.
 */
export function MessageItem({ message, onShowFull, onOpenAttachment }: MessageItemProps) {
  const sender = message.fromName || message.fromAddress;
  const ours = message.fromTeam;
  const card = message.display === "card";
  return (
    <View style={[styles.item, ours && !card && styles.ours]}>
      <View style={[styles.meta, ours && !card && styles.oursMeta]}>
        <Avatar name={sender} logo={{ address: message.fromAddress }} size={32} />
        <Text weight="medium" numberOfLines={1} style={styles.shrink}>
          {sender}
        </Text>
        <Text size="sm" tone="mutedForeground" tabular style={styles.keep}>
          {listTime(message.sentAt)}
        </Text>
      </View>
      <View style={card ? styles.card : [styles.bubble, ours && styles.oursBubble]}>
        <Text selectable>{message.cleanText}</Text>
      </View>
      {message.attachments.length ? (
        <View style={[styles.attachments, ours && !card && styles.oursMeta]}>
          {message.attachments.map((file) => (
            <PressableRow
              key={file.id}
              style={styles.chip}
              onPress={onOpenAttachment && (() => onOpenAttachment(file))}
            >
              <IconPaperclip size={iconSize.sm} color={colors.mutedForeground} />
              <Text size="sm" numberOfLines={1} ellipsizeMode="middle" style={styles.shrink}>
                {file.filename}
              </Text>
            </PressableRow>
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
  item: { gap: space(2.5), alignItems: "flex-start" },
  ours: { alignItems: "flex-end" },
  meta: { flexDirection: "row", alignItems: "center", gap: space(2.5), maxWidth: "100%" },
  oursMeta: { justifyContent: "flex-end" },
  shrink: { flexShrink: 1, minWidth: 0 },
  keep: { flexShrink: 0 },
  bubble: {
    maxWidth: "88%",
    paddingHorizontal: space(4),
    paddingVertical: space(3),
    borderRadius: radius.card,
    backgroundColor: colors.accent,
  },
  oursBubble: { backgroundColor: colors.primarySubtle },
  card: {
    alignSelf: "stretch",
    padding: space(5),
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
    maxWidth: "100%",
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  oursAction: { alignSelf: "flex-end" },
});
