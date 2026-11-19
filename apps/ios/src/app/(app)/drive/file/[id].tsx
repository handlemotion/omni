import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { useFileMenu } from "@/components/drive/file-menu.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { IconFile } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useNode } from "@/lib/drive-actions.ts";
import { fileSource } from "@/lib/drive.ts";
import { keys } from "@/lib/query-keys.ts";
import { colors, space } from "@/theme/tokens.ts";

/** A file, previewed by iOS itself (PDFs, images, text, Office documents) in a web view. */
export default function FilePreview() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const source = useQuery({ queryKey: keys.fileSource(id), queryFn: () => fileSource(id) });
  const nodeQuery = useNode(id);
  const node = nodeQuery.data?.node;
  const menu = useFileMenu(node);
  const ready = source.data && (node || nodeQuery.isError);
  return (
    <>
      <Stack.Screen options={{ title: node?.name ?? name ?? "" }} />
      <Stack.Toolbar placement="right">{menu}</Stack.Toolbar>
      {ready ? (
        <WebView
          key={node?.contentVersion ?? node?.updatedAt}
          source={source.data}
          style={styles.view}
          originWhitelist={["*"]}
          javaScriptEnabled={false}
          contentInsetAdjustmentBehavior="automatic"
          renderError={() => (
            <EmptyState icon={IconFile} title="This file didn't load">
              <Button intent="plain" label="Try again" onPress={() => void source.refetch()} />
            </EmptyState>
          )}
        />
      ) : (
        <View style={styles.loading}>
          <Skeleton width="90%" height={14} />
          <Skeleton width="70%" height={14} />
        </View>
      )}
      <UploadsPanel />
    </>
  );
}

const styles = StyleSheet.create({
  view: { flex: 1, backgroundColor: colors.background },
  loading: { padding: space(4), gap: space(3) },
});
