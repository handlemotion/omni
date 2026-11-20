import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutRectangle,
  type ScrollViewInstance,
} from "react-native";
import { IconFile } from "@/components/icons.ts";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { contentUrl, thumbnailUrl, useStorageHeaders, versionOf } from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { colors } from "@/theme/tokens.ts";
import { hasThumbnail } from "./file-glyph.tsx";

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 280;

type Size = Pick<LayoutRectangle, "width" | "height">;

/**
 * Images as Photos shows them: one a page, swiped sideways through the folder's images; pinch or
 * double tap to zoom, and pan a zoomed image up to its edge before the next one takes over. The
 * zoom is UIKit's own (a zooming `UIScrollView` per page). A page shows the Worker's 1280 px
 * thumbnail, decoded no larger than the screen, and swaps in the original at full size only once
 * it is zoomed, so swiping through a folder of large photos holds a few screen-sized bitmaps. The image on screen stays on screen when a rename re-sorts the folder.
 */
export function ImageViewer(props: {
  images: DriveNode[];
  initialId: string;
  onChange: (node: DriveNode) => void;
}) {
  const [size, setSize] = useState<Size | null>(null);
  const headers = useStorageHeaders().data;
  const start = Math.max(
    0,
    props.images.findIndex((one) => one.id === props.initialId),
  );
  const list = useRef<FlatList<DriveNode>>(null);
  const visible = useRef(props.initialId);
  const at = props.images.findIndex((one) => one.id === visible.current);
  useEffect(() => {
    if (size && at >= 0) list.current?.scrollToOffset({ offset: at * size.width, animated: false });
  }, [at, size]);
  return (
    <View
      style={styles.fill}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize({ width, height });
      }}
    >
      {size && headers ? (
        <FlatList
          ref={list}
          data={props.images}
          keyExtractor={(node) => node.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={start}
          getItemLayout={(_, index) => ({ length: size.width, offset: size.width * index, index })}
          initialNumToRender={1}
          windowSize={3}
          maxToRenderPerBatch={2}
          onMomentumScrollEnd={(event) => {
            const index = Math.round(event.nativeEvent.contentOffset.x / size.width);
            const node = props.images[index];
            if (!node) return;
            visible.current = node.id;
            props.onChange(node);
          }}
          renderItem={({ item }) => <ZoomableImage node={item} headers={headers} size={size} />}
        />
      ) : null}
    </View>
  );
}

function ZoomableImage({
  node,
  headers,
  size,
}: {
  node: DriveNode;
  headers: Record<string, string>;
  size: Size;
}) {
  const scroll = useRef<ScrollViewInstance>(null);
  const zoomed = useRef(false);
  const lastTap = useRef(0);
  const [failed, setFailed] = useState(false);
  const [zoomedIn, setZoomedIn] = useState(false);
  const [noThumbnail, setNoThumbnail] = useState(!hasThumbnail(node));
  const version = versionOf(node);
  const original = { uri: contentUrl(node.id), headers, cacheKey: `${node.id}:${version}` };
  const thumbnail = {
    uri: thumbnailUrl(node, 1280),
    headers,
    cacheKey: `${node.id}:${version}:1280`,
  };
  const showOriginal = zoomedIn || noThumbnail;

  const onPress = (event: GestureResponderEvent) => {
    const now = Date.now();
    if (now - lastTap.current > DOUBLE_TAP_MS) {
      lastTap.current = now;
      return;
    }
    lastTap.current = 0;
    if (zoomed.current) {
      scroll.current?.scrollResponderZoomTo({ x: 0, y: 0, ...size, animated: true });
      return;
    }
    const width = size.width / DOUBLE_TAP_ZOOM;
    const height = size.height / DOUBLE_TAP_ZOOM;
    const { locationX, locationY } = event.nativeEvent;
    scroll.current?.scrollResponderZoomTo({
      x: locationX - width / 2,
      y: locationY - height / 2,
      width,
      height,
      animated: true,
    });
  };

  if (failed) {
    return (
      <View style={size}>
        <EmptyState icon={IconFile} title="This image didn't load" />
      </View>
    );
  }
  return (
    <ScrollView
      ref={scroll}
      style={size}
      contentContainerStyle={size}
      minimumZoomScale={1}
      maximumZoomScale={MAX_ZOOM}
      bouncesZoom
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={32}
      onScroll={(event) => {
        zoomed.current = (event.nativeEvent.zoomScale ?? 1) > 1.01;
        if (zoomed.current && !zoomedIn) setZoomedIn(true);
      }}
    >
      <Pressable onPress={onPress} accessibilityRole="image" accessibilityLabel={node.name}>
        <Image
          source={showOriginal ? original : thumbnail}
          placeholder={zoomedIn && !noThumbnail ? thumbnail : undefined}
          placeholderContentFit="contain"
          style={size}
          contentFit="contain"
          allowDownscaling={!zoomedIn}
          transition={zoomedIn ? 0 : 150}
          recyclingKey={node.id}
          onError={() => (showOriginal ? setFailed(true) : setNoThumbnail(true))}
        />
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
});
