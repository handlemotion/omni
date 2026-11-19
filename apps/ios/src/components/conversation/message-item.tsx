import type { Message } from "@omni/client";
import { useState } from "react";
import { ActionSheetIOS, Pressable, StyleSheet, View } from "react-native";
import { HtmlView } from "@/components/conversation/html-view";
import { Avatar } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { FileTile } from "@/components/ui/file-tile.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { config } from "@/lib/config.ts";
import { fileSize } from "@/lib/drive.ts";
import { listTime, useMessageHtml } from "@/lib/mail.ts";
import { opensFull } from "@/lib/message-html.ts";
import { colors, gutter, radius, space } from "@/theme/tokens.ts";

type Attachment = Message["attachments"][number];

export interface MessageItemProps {
  threadId: string;
  message: Message;
  /** Its text shows; collapsed, only its header with the first words. */
  expanded: boolean;
  onToggle: () => void;
  /** The thread's mailbox address: it reads as "me" among the recipients. */
  self: string;
  /** A hairline under it: every message but the last. */
  divided: boolean;
  onOpenAttachment?: (file: Attachment) => void;
}

/**
 * One message, collapsed or open, under the same header: the sender's square avatar, their name
 * with the time, then the first words (collapsed) or who it went to (open). Open, it shows what
 * they newly wrote, or the sender's HTML in place when the message has no text of its own; a
 * long press switches between the two, as the web's message menu does. Then its attachments.
 */
export function MessageItem(props: MessageItemProps) {
  const { message, expanded } = props;
  const [full, setFull] = useState(() => opensFull(message));
  const sender = message.fromName || message.fromAddress;
  const switchable = message.hasHtml && !!message.cleanText.trim();
  return (
    <View style={[styles.item, props.divided && styles.divided]}>
      <PressableRow shape="bare" isExpanded={expanded} onPress={props.onToggle}>
        <Avatar
          name={sender}
          logo={{ address: message.fromAddress }}
          size={space(10)}
          shape="square"
        />
        <View style={styles.lines}>
          <View style={styles.top}>
            <Text size="body" weight="semibold" numberOfLines={1} style={styles.name}>
              {sender}
            </Text>
            <Text size="caption" tone="mutedForeground" tabular style={styles.keep}>
              {listTime(message.sentAt)}
            </Text>
          </View>
          <Text size="sm" tone="mutedForeground" numberOfLines={1}>
            {expanded ? recipientsLine(message, props.self) : snippetOf(message.cleanText)}
          </Text>
        </View>
      </PressableRow>
      {expanded ? (
        <Pressable
          accessibilityHint={
            switchable ? "Long press to switch between the text and the full message" : undefined
          }
          onLongPress={
            switchable ? () => offerSwitch(full, () => setFull((open) => !open)) : undefined
          }
        >
          {full ? (
            <FullMessage threadId={props.threadId} messageId={message.id} />
          ) : (
            <Paragraphs text={message.cleanText} />
          )}
        </Pressable>
      ) : null}
      {expanded && message.attachments.length ? (
        <View style={styles.attachments}>
          {message.attachments.map((file) => (
            <AttachmentChip
              key={file.id}
              file={file}
              onPress={props.onOpenAttachment && (() => props.onOpenAttachment?.(file))}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Paragraphs({ text }: { text: string }) {
  const paragraphs = text.trim().split(/\n\s*\n/);
  return (
    <View style={styles.paragraphs}>
      {paragraphs.map((paragraph, i) => (
        <Text key={i} size="reading" selectable>
          {paragraph}
        </Text>
      ))}
    </View>
  );
}

function AttachmentChip({ file, onPress }: { file: Attachment; onPress?: () => void }) {
  return (
    <PressableRow
      shape="inset"
      style={styles.chip}
      onPress={onPress}
      accessibilityLabel={`${file.filename}, ${fileSize(file.size)}`}
    >
      <FileTile name={file.filename} mimeType={file.mimeType} />
      <View style={styles.file}>
        <Text size="sm" weight="medium" numberOfLines={1} ellipsizeMode="middle">
          {file.filename}
        </Text>
        <Text size="caption" tone="mutedForeground" tabular numberOfLines={1}>
          {fileSize(file.size)}
        </Text>
      </View>
    </PressableRow>
  );
}

const snippetOf = (text: string) => text.replace(/\s+/g, " ").trim();

function recipientsLine(message: Message, self: string) {
  const names = [...message.to, ...message.cc].map((a) =>
    a.address.toLowerCase() === self.toLowerCase()
      ? "me"
      : (a.name?.trim().split(/\s+/)[0] ?? "") || a.address,
  );
  return names.length ? `To ${names.join(", ")}` : "To undisclosed recipients";
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
  item: { padding: gutter, gap: space(4) },
  divided: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  lines: { flex: 1, minWidth: 0, gap: space(0.5) },
  top: { flexDirection: "row", alignItems: "baseline", gap: space(2) },
  name: { flex: 1, minWidth: 0 },
  keep: { flexShrink: 0 },
  paragraphs: { gap: space(3) },
  attachments: { alignItems: "flex-start", gap: space(2) },
  chip: {
    alignItems: "center",
    gap: space(3),
    minWidth: space(55),
    maxWidth: "100%",
    paddingHorizontal: space(3),
    paddingVertical: space(3),
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  file: { flexShrink: 1, minWidth: 0 },
  loading: { gap: space(3) },
});
