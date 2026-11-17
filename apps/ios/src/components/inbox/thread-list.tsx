import type { Mailbox, ThreadSummary } from "@omni/client";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { IconInbox } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { MAIL_PAGES, mailboxName, useThreads, type MailPage } from "@/lib/mail.ts";
import { colors, space } from "@/theme/tokens.ts";
import { ThreadListSkeleton } from "./thread-list-skeleton.tsx";
import { ThreadRow } from "./thread-row.tsx";

export interface ThreadListProps {
  page: MailPage;
  /** One mailbox, or every inbox the person can open. */
  mailboxId: string | undefined;
  mailboxes: Mailbox[];
  you: string;
  onOpenThread?: (thread: ThreadSummary) => void;
}

/** A mail page's threads: newest first, older ones as you scroll, pull to refresh. */
export function ThreadList({ page, mailboxId, mailboxes, you, onOpenThread }: ThreadListProps) {
  const inbox = useThreads(page, mailboxId);
  if (inbox.isPending) return <ThreadListSkeleton />;
  if (inbox.isError && !inbox.data) {
    return (
      <EmptyState icon={IconInbox} title="This list didn't load">
        <Button intent="plain" label="Try again" onPress={() => void inbox.refetch()} />
      </EmptyState>
    );
  }
  const shared = new Map(
    mailboxId
      ? []
      : mailboxes.filter((m) => m.kind === "shared").map((m) => [m.id, mailboxName(m, you)]),
  );
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      data={inbox.data}
      keyExtractor={(thread) => thread.id}
      renderItem={({ item }) => (
        <ThreadRow
          thread={item}
          sharedInbox={shared.get(item.mailboxId)}
          onPress={onOpenThread ? () => onOpenThread(item) : undefined}
        />
      )}
      ItemSeparatorComponent={Separator}
      contentContainerStyle={inbox.data.length ? null : styles.fill}
      ListEmptyComponent={<EmptyState icon={IconInbox} title={MAIL_PAGES[page].empty} />}
      onEndReached={() => {
        if (inbox.hasNextPage && !inbox.isFetchingNextPage) void inbox.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={inbox.isRefetching && !inbox.isFetchingNextPage}
          onRefresh={() => void inbox.refetch()}
          tintColor={colors.mutedForeground}
        />
      }
    />
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  fill: { flexGrow: 1 },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: space(17),
  },
});
