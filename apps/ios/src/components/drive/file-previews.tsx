import { useEvent } from "expo";
import { VideoView, useVideoPlayer } from "expo-video";
import { ScrollView, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { IconFile } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Text } from "@/components/ui/text.tsx";
import { shareFile } from "@/lib/drive-actions.ts";
import { existingCopy } from "@/lib/drive-files.ts";
import {
  contentUrl,
  sourceOf,
  useFileText,
  useLocalCopy,
  useStorageHeaders,
} from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { colors, gutter, space } from "@/theme/tokens.ts";

export function PreviewLoading() {
  return (
    <View style={styles.loading}>
      <Skeleton width="90%" height={14} />
      <Skeleton width="70%" height={14} />
    </View>
  );
}

function DidNotLoad({ retry }: { retry: () => void }) {
  return (
    <EmptyState icon={IconFile} title="This file didn't load">
      <Button intent="plain" label="Try again" onPress={retry} />
    </EmptyState>
  );
}

/** A file nothing on the phone shows: its name, and Download (the share sheet). */
export function NoPreview({ node }: { node: DriveNode }) {
  return (
    <EmptyState icon={IconFile} title={node.name}>
      <Button intent="plain" label="Download" onPress={() => void shareFile(node)} />
    </EmptyState>
  );
}

/**
 * Video and audio streamed by the system player as they play (the Worker answers its `Range`
 * requests), so a 2 GB film starts in seconds instead of after a download. A copy already on the
 * phone (made available offline) plays from there, with no network.
 */
export function MediaPreview({ node }: { node: DriveNode }) {
  const headers = useStorageHeaders().data;
  if (!headers) return <PreviewLoading />;
  return <MediaPlayer node={node} headers={headers} />;
}

function MediaPlayer({ node, headers }: { node: DriveNode; headers: Record<string, string> }) {
  const local = existingCopy(sourceOf(node));
  const player = useVideoPlayer(local ? local.uri : { uri: contentUrl(node.id), headers }, (one) =>
    one.play(),
  );
  const { status } = useEvent(player, "statusChange", { status: player.status });
  if (status === "error") return <NoPreview node={node} />;
  return (
    <VideoView
      player={player}
      style={styles.fill}
      contentFit="contain"
      nativeControls
      allowsPictureInPicture={false}
    />
  );
}

/** PDFs, Office and iWork documents, drawn by iOS from a local copy. */
export function NativePreview({ node }: { node: DriveNode }) {
  const copy = useLocalCopy(node);
  if (copy.isError) return <DidNotLoad retry={() => void copy.refetch()} />;
  if (!copy.data) return <PreviewLoading />;
  return (
    <WebView
      source={{ uri: copy.data.uri }}
      allowingReadAccessToURL={copy.data.folderUri}
      allowFileAccess
      originWhitelist={["*"]}
      javaScriptEnabled={false}
      allowsInlineMediaPlayback
      style={styles.fill}
      contentInsetAdjustmentBehavior="automatic"
      renderError={() => <DidNotLoad retry={() => void copy.refetch()} />}
    />
  );
}

/** Code, notes and CSV as their text. A file with NUL bytes in it is not text. */
export function TextPreview({ node }: { node: DriveNode }) {
  const text = useFileText(node);
  if (text.isError) return <DidNotLoad retry={() => void text.refetch()} />;
  if (!text.data) return <PreviewLoading />;
  if (text.data.binary) return <NoPreview node={node} />;
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.text}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text size="sm" selectable>
        {text.data.text}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
  loading: { padding: space(4), gap: space(3) },
  text: { paddingHorizontal: gutter, paddingVertical: space(4) },
});
