import type { Message } from "@omni/client";
import { useState } from "react";
import { ActionSheetIOS, Pressable, StyleSheet, View } from "react-native";
import { HtmlView } from "@/components/conversation/html-view";
import { IconPaperclip } from "@/components/icons.ts";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { config } from "@/lib/config.ts";
import { listTime, useMessageHtml } from "@/lib/mail.ts";
import { opensFull } from "@/lib/message-html.ts";
import { colors, iconSize, radius, shadowRaised, space } from "@/theme/tokens.ts";

export interface MessageItemProps {
  threadId: string;
  message: Message;
  /** The thread's only message, shown as the page: a card without its edge. */
  flat?: boolean;
  onOpenAttachment?: (file: Message["attachments"][number]) => void;
}

/**
 * One message as the spec draws it: who and when, then only what they newly wrote. Short ones are
 * bubbles (yours and your team's on the right, tinted), long or formal ones cards (`display`,
 * decided by the Worker). Either can show the sender's HTML in place, as on the web; a message
 * with no text of its own, or outside mail its images carry, opens that way; a long press
 * switches between the two, as the web's message menu does.
 */
export function MessageItem({ threadId, message, flat, onOpenAttachment }: MessageItemProps) {
  const [full, setFull] = useState(() => opensFull(message));
  const sender = message.fromName || message.fromAddress;
  const card = message.display === "card" || full || !!flat;
  const ours = message.fromTeam && !card;
  const switchable = message.hasHtml && !!message.cleanText.trim();
  return (
    <Pressable
      accessibilityHint={
        switchable ? "Long press to switch between the text and the full message" : undefined
      }
      onLongPress={switchable ? () => offerSwitch(full, () => setFull((open) => !open)) : undefined}
      style={[styles.item, ours && styles.ours]}
    >
      <View style={[styles.meta, ours && styles.oursMeta]}>
        <Avatar name={sender} logo={{ address: message.fromAddress }} size={32} />
        <Text weight="medium" numberOfLines={1} style={styles.shrink}>
          {sender}
        </Text>
        <Text size="sm" tone="mutedForeground" tabular style={styles.keep}>
          {listTime(message.sentAt)}
        </Text>
      </View>
      {full ? (
        <View style={[styles.card, styles.fullCard, flat && styles.flat]}>
          <FullMessage threadId={threadId} messageId={message.id} />
        </View>
      ) : (
        <View
          style={
            card
              ? [styles.card, styles.textCard, flat && styles.flat]
              : [styles.bubble, ours && styles.oursBubble]
          }
        >
          <Text selectable>{message.cleanText}</Text>
        </View>
      )}
      {message.attachments.length ? (
        <View style={[styles.attachments, ours && styles.oursMeta]}>
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
    </Pressable>
  );
}

function offerSwitch(full: boolean, onSwitch: () => void) {
  ActionSheetIOS.showActionSheetWithOptions(
    { options: [full ? "Show text" : "Show full message", "Cancel"], cancelButtonIndex: 1 },
    (index) => index === 0 && onSwitch(),
  );
}

function FullMessage({ threadId, messageId }: { threadId: string; messageId: string }) {
  const html = useMessageHtml(threadId, messageId);
  if (html.data !== undefined) return <HtmlView html={html.data} baseUrl={config.apiUrl} />;
  if (html.isError)
    return <Button intent="plain" label="Try again" onPress={() => void html.refetch()} />;
  return (
    <View style={styles.loading}>
      <Skeleton width="90%" height={14} />
      <Skeleton width="70%" height={14} />
      <Skeleton width="80%" height={14} />
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
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadowRaised,
  },
  textCard: { padding: space(5) },
  fullCard: { overflow: "hidden" },
  flat: { padding: 0, borderWidth: 0, shadowOpacity: 0, elevation: 0 },
  loading: { padding: space(4), gap: space(3) },
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
});
