import { Stack, useLocalSearchParams } from "expo-router";
import { Alert, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { IconFile } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { shareAttachment, useAttachmentFile, useSaveToDrive } from "@/lib/attachments.ts";
import { colors, space } from "@/theme/tokens.ts";

/**
 * A message's attachment, previewed by iOS itself (PDFs, images, text, Office documents) as
 * Drive's file preview does, with Share (Save to Files, open in another app) and Save to Drive.
 */
export default function AttachmentPreview() {
  const params = useLocalSearchParams<{
    threadId: string;
    attachmentId: string;
    name?: string;
    mimeType?: string;
  }>();
  const name = params.name || "Attachment";
  const file = useAttachmentFile({
    threadId: params.threadId,
    attachmentId: params.attachmentId,
    filename: name,
  });
  const saveToDrive = useSaveToDrive();
  const save = () =>
    saveToDrive.mutate(params.attachmentId, {
      onSuccess: () => Alert.alert("Saved to Drive"),
      onError: (error) => Alert.alert("Couldn't save to Drive", error.message),
    });
  return (
    <>
      <Stack.Screen options={{ title: name }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="square.and.arrow.up"
          accessibilityLabel="Share"
          disabled={!file.data}
          onPress={() => file.data && void shareAttachment(file.data.uri, params.mimeType, name)}
        />
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More">
          <Stack.Toolbar.MenuAction
            icon="externaldrive"
            disabled={saveToDrive.isPending}
            onPress={save}
          >
            Save to Drive
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {file.data ? (
        <WebView
          source={{ uri: file.data.uri }}
          allowingReadAccessToURL={file.data.folderUri}
          allowFileAccess
          originWhitelist={["*"]}
          javaScriptEnabled={false}
          style={styles.view}
          contentInsetAdjustmentBehavior="automatic"
        />
      ) : file.isError ? (
        <EmptyState icon={IconFile} title="This file didn't load">
          <Button intent="plain" label="Try again" onPress={() => void file.refetch()} />
        </EmptyState>
      ) : (
        <View style={styles.loading}>
          <Skeleton width="90%" height={14} />
          <Skeleton width="70%" height={14} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  view: { flex: 1, backgroundColor: colors.background },
  loading: { padding: space(4), gap: space(3) },
});
