import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { HtmlView } from "@/components/conversation/html-view";
import { IconInbox } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { config } from "@/lib/config.ts";
import { useMessageHtml } from "@/lib/mail.ts";
import { colors, space } from "@/theme/tokens.ts";

/** "Full message": the original HTML, sanitized by the Worker, with scripts off. */
export default function FullMessage() {
  const { threadId, messageId } = useLocalSearchParams<{ threadId: string; messageId: string }>();
  const html = useMessageHtml(threadId, messageId);
  return (
    <Screen edges={[]}>
      {html.isPending ? (
        <View style={styles.loading}>
          <Skeleton width="90%" height={14} />
          <Skeleton width="70%" height={14} />
          <Skeleton width="80%" height={14} />
        </View>
      ) : html.isError ? (
        <EmptyState icon={IconInbox} title="This message didn't load">
          <Button intent="plain" label="Try again" onPress={() => void html.refetch()} />
        </EmptyState>
      ) : (
        <View style={styles.body}>
          <HtmlView html={html.data} baseUrl={config.apiUrl} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { padding: space(4), gap: space(3) },
  body: { flex: 1, backgroundColor: colors.background },
});
