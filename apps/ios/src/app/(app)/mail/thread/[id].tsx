import type { Thread } from "@omni/client";
import { router, useIsPreview, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MessageItem } from "@/components/conversation/message-item.tsx";
import { PropertiesRail } from "@/components/conversation/properties-rail.tsx";
import { ThreadBottomBar, ThreadTopBar } from "@/components/conversation/thread-bars.tsx";
import { useThreadActions } from "@/components/conversation/use-thread-actions.ts";
import { IconInbox } from "@/components/icons.ts";
import { FLOATING_BAR_SPACE } from "@/components/shell/floating-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { idempotencyKey } from "@/lib/ids.ts";
import { useMarkRead, useThread } from "@/lib/mail.ts";
import { colors, gutter, space } from "@/theme/tokens.ts";

/**
 * A conversation, read top to bottom under its own bar (back, ⋯) and properties rail, its
 * actions floating at the bottom. Opening it marks it read, as on the web; a long-press peek at
 * it does not.
 */
export default function ThreadScreen() {
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>();
  const thread = useThread(id);
  const actions = useThreadActions(page);
  useMarkReadOnOpen(id, thread.data?.read);

  return (
    <Screen edges={[]}>
      <ThreadTopBar thread={thread.data} page={page} actions={actions} />
      {thread.isPending ? (
        <View style={styles.loading}>
          <Skeleton width="85%" height={28} />
          <Skeleton width="55%" height={28} />
          <Skeleton width="40%" height={16} />
          <Skeleton width="75%" height={72} />
        </View>
      ) : thread.isError ? (
        <EmptyState icon={IconInbox} title="This conversation didn't load">
          <Button intent="plain" label="Try again" onPress={() => void thread.refetch()} />
        </EmptyState>
      ) : (
        <>
          <PropertiesRail thread={thread.data} />
          <Conversation thread={thread.data} />
          <ThreadBottomBar thread={thread.data} page={page} actions={actions} />
        </>
      )}
    </Screen>
  );
}

function Conversation({ thread }: { thread: Thread }) {
  const last = thread.messages.at(-1)?.id;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(last ? [last] : []));
  const toggle = (messageId: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.subject}>
        <Text size="heading" weight="semibold" accessibilityRole="header" selectable>
          {thread.messages[0]?.subject ?? ""}
        </Text>
      </View>
      {thread.messages.map((message) => (
        <MessageItem
          key={message.id}
          threadId={thread.id}
          message={message}
          expanded={open.has(message.id)}
          onToggle={() => toggle(message.id)}
          self={thread.mailboxAddress}
          divided={message.id !== last}
          onOpenAttachment={(file) =>
            router.push({
              pathname: "/mail/attachment/[threadId]/[attachmentId]",
              params: {
                threadId: thread.id,
                attachmentId: file.id,
                name: file.filename,
                mimeType: file.mimeType,
              },
            })
          }
        />
      ))}
    </ScrollView>
  );
}

function useMarkReadOnOpen(threadId: string, read: boolean | undefined) {
  const markRead = useMarkRead();
  const peeking = useIsPreview();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (peeking || read === undefined || sent.current === threadId) return;
    sent.current = threadId;
    if (!read) markRead.mutate({ threadId, key: idempotencyKey() });
  }, [threadId, read, markRead, peeking]);
}

const styles = StyleSheet.create({
  loading: { padding: gutter, gap: space(8) },
  content: { paddingBottom: FLOATING_BAR_SPACE },
  subject: {
    padding: gutter,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
