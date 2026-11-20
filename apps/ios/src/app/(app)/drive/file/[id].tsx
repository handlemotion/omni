import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  MediaPreview,
  NativePreview,
  NoPreview,
  PreviewLoading,
  TextPreview,
} from "@/components/drive/file-previews.tsx";
import { ImageViewer } from "@/components/drive/image-viewer.tsx";
import { NodeSheet } from "@/components/drive/node-sheet.tsx";
import { DownloadsPanel } from "@/components/drive/downloads-panel.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { IconFile } from "@/components/icons.ts";
import { useSheet } from "@/components/ui/bottom-sheet.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { useNode } from "@/lib/drive-actions.ts";
import { useFolderImages, versionOf } from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { fileKindOf, previewKindOf } from "@/lib/file-kind.ts";

/**
 * A file: images in the photo viewer, swiping through the folder's images; text as text; video
 * and audio streamed; what iOS can draw (PDFs, Office documents) from a local copy; anything
 * else, Download.
 */
export default function FilePreview() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const nodeQuery = useNode(id);
  const node = nodeQuery.data?.node;
  const kind = node ? previewKindOf(node) : null;
  const images = useFolderImages(kind === "image" ? node : undefined);
  const [swipedTo, setSwipedTo] = useState<DriveNode | null>(null);
  const shown = images?.find((one) => one.id === swipedTo?.id) ?? node;
  const sheet = useSheet();
  return (
    <>
      <Stack.Screen options={{ title: shown?.name ?? name ?? "" }} />
      {shown ? (
        <>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              icon="ellipsis"
              accessibilityLabel={`Actions for ${shown.name}`}
              onPress={sheet.open}
            />
          </Stack.Toolbar>
          <NodeSheet
            node={shown}
            sheet={sheet}
            onTrashed={() => router.canGoBack() && router.back()}
          />
        </>
      ) : null}
      {node ? (
        <Preview key={versionOf(node)} node={node} images={images} onSwipe={setSwipedTo} />
      ) : nodeQuery.isError ? (
        <EmptyState icon={IconFile} title="This file didn't load">
          <Button intent="plain" label="Try again" onPress={() => void nodeQuery.refetch()} />
        </EmptyState>
      ) : (
        <PreviewLoading />
      )}
      <UploadsPanel />
      <DownloadsPanel />
    </>
  );
}

function Preview(props: {
  node: DriveNode;
  images: DriveNode[] | null;
  onSwipe: (node: DriveNode) => void;
}) {
  switch (previewKindOf(props.node)) {
    case "image":
      if (!props.images) return <PreviewLoading />;
      return (
        <ImageViewer images={props.images} initialId={props.node.id} onChange={props.onSwipe} />
      );
    case "text":
      return <TextPreview node={props.node} />;
    case "native": {
      const kind = fileKindOf(props.node);
      if (kind === "video" || kind === "audio") return <MediaPreview node={props.node} />;
      return <NativePreview node={props.node} />;
    }
    case "none":
      return <NoPreview node={props.node} />;
  }
}
