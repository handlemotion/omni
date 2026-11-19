import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ForwardComposer, NewComposer, ReplyComposer } from "@/components/compose/composer.tsx";
import { IconInbox } from "@/components/icons.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useMailboxes, useThread } from "@/lib/mail.ts";
import { gutter, space } from "@/theme/tokens.ts";

/**
 * Writing mail, in a sheet: a reply to `threadId` (to everyone on it with `all=1`, or a forward
 * of it with `forward=1`), else new mail from `mailbox` or the first one here.
 */
export default function Compose() {
  const { threadId, all, forward, mailbox } = useLocalSearchParams<{
    threadId?: string;
    all?: string;
    forward?: string;
    mailbox?: string;
  }>();
  if (threadId && forward === "1") return <Forward threadId={threadId} />;
  return threadId ? (
    <Reply threadId={threadId} replyAll={all === "1"} />
  ) : (
    <New mailboxId={mailbox} />
  );
}

function Reply({ threadId, replyAll }: { threadId: string; replyAll: boolean }) {
  const thread = useThread(threadId);
  if (thread.data) return <ReplyComposer thread={thread.data} replyAll={replyAll} />;
  return <Pending failed={thread.isError} />;
}

function Forward({ threadId }: { threadId: string }) {
  const thread = useThread(threadId);
  if (thread.data) return <ForwardComposer thread={thread.data} />;
  return <Pending failed={thread.isError} />;
}

function New({ mailboxId }: { mailboxId?: string }) {
  const mailboxes = useMailboxes();
  if (mailboxes.data?.length)
    return <NewComposer mailboxes={mailboxes.data} mailboxId={mailboxId} />;
  return <Pending failed={mailboxes.isError || mailboxes.data?.length === 0} />;
}

function Pending({ failed }: { failed: boolean }) {
  if (failed) return <EmptyState icon={IconInbox} title="Can't write mail here" />;
  return (
    <View style={styles.pending}>
      <Skeleton width="70%" height={20} />
      <Skeleton width="50%" height={20} />
      <Skeleton width="90%" height={20} />
    </View>
  );
}

const styles = StyleSheet.create({
  pending: { padding: gutter, gap: space(5) },
});
