import { Stack, router, useIsPreview, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MessageItem } from "@/components/conversation/message-item.tsx";
import { ThreadActions } from "@/components/conversation/thread-actions.tsx";
import { ThreadTitle } from "@/components/conversation/thread-header.tsx";
import { IconInbox } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { idempotencyKey } from "@/lib/ids.ts";
import { mailboxName, useMarkRead, useThread } from "@/lib/mail.ts";
import { useSession } from "@/lib/session.ts";
import { gutter, space } from "@/theme/tokens.ts";

/** A conversation, read top to bottom. Opening it marks it read, as on the web; a long-press peek at it does not. */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const thread = useThread(id);
  const session = useSession();
  const you = session.data?.user.name || session.data?.user.email || "";
  useMarkReadOnOpen(id, thread.data?.read);

  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: "" }} />
      <ThreadActions threadId={id} />
      {thread.isPending ? (
        <View style={styles.content}>
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
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
        >
          <ThreadTitle
            subject={thread.data.messages[0]?.subject ?? ""}
            sharedInbox={
              thread.data.mailboxKind === "shared"
                ? mailboxName({ kind: "shared", address: thread.data.mailboxAddress }, you)
                : undefined
            }
          />
          {thread.data.messages.map((message) => (
            <MessageItem
              key={message.id}
              threadId={id}
              message={message}
              flat={thread.data.messages.length === 1}
              onOpenAttachment={(file) =>
                router.push({
                  pathname: "/mail/attachment/[threadId]/[attachmentId]",
                  params: {
                    threadId: id,
                    attachmentId: file.id,
                    name: file.filename,
                    mimeType: file.mimeType,
                  },
                })
              }
            />
          ))}
        </ScrollView>
      )}
    </Screen>
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
  content: {
    paddingHorizontal: gutter,
    paddingTop: space(2),
    paddingBottom: space(16),
    gap: space(8),
  },
});
