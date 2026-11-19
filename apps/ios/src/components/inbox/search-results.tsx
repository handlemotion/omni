import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { IconInbox } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { ListSkeleton } from "@/components/ui/list-skeleton.tsx";
import { LoadingPage } from "@/components/ui/loading-page.tsx";
import { useSearch } from "@/lib/mail.ts";
import { space } from "@/theme/tokens.ts";
import { ThreadRow } from "./thread-row.tsx";

/** Threads matching `q` across the workspace's mail, best first; a tap opens one. */
export function SearchResults({ q }: { q: string }) {
  const search = useSearch(q);
  if (search.isPending) {
    return (
      <LoadingPage>
        <ListSkeleton round />
      </LoadingPage>
    );
  }
  if (!search.data?.length) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.fill}
      >
        {search.isError ? (
          <EmptyState icon={IconInbox} title="Search didn't load">
            <Button intent="plain" label="Try again" onPress={() => void search.refetch()} />
          </EmptyState>
        ) : (
          <EmptyState icon={IconInbox} title="No results" />
        )}
      </ScrollView>
    );
  }
  return (
    <FlashList
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      data={search.data}
      keyExtractor={(hit) => hit.threadId}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <ThreadRow
          thread={{
            sender: item.from.name || item.from.address,
            senderAddress: item.from.address,
            subject: item.subject,
            snippet: item.snippet,
            unread: item.unread,
            lastMessageAt: item.lastMessageAt,
            messageCount: item.messageCount,
          }}
          onPress={() =>
            router.push({ pathname: "/mail/thread/[id]", params: { id: item.threadId } })
          }
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flexGrow: 1 },
  list: { paddingTop: space(1), paddingBottom: space(8) },
});
