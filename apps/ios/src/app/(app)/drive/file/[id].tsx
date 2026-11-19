import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useFileMenu } from "@/components/drive/file-menu.tsx";
import {
  NativePreview,
  NoPreview,
  PreviewLoading,
  TextPreview,
} from "@/components/drive/file-previews.tsx";
import { ImageViewer } from "@/components/drive/image-viewer.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { IconFile } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { useNode } from "@/lib/drive-actions.ts";
import { useFolderImages, versionOf } from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { previewKindOf } from "@/lib/file-kind.ts";

/**
 * A file: images in the photo viewer, swiping through the folder's images; text as text; what
 * iOS can draw (PDFs, video, Office documents) from a local copy; anything else, Download.
 */
export default function FilePreview() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const nodeQuery = useNode(id);
  const node = nodeQuery.data?.node;
  const kind = node ? previewKindOf(node) : null;
  const images = useFolderImages(kind === "image" ? node : undefined);
  const [swipedTo, setSwipedTo] = useState<DriveNode | null>(null);
  const shown = images?.find((one) => one.id === swipedTo?.id) ?? node;
  const menu = useFileMenu(shown);
  return (
    <>
      <Stack.Screen options={{ title: shown?.name ?? name ?? "" }} />
      <Stack.Toolbar placement="right">{menu}</Stack.Toolbar>
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
    case "native":
      return <NativePreview node={props.node} />;
    case "none":
      return <NoPreview node={props.node} />;
  }
}
