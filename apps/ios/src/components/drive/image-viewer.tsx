import { Image } from "expo-image";
import { useRef, useState } from "react";
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
import { contentUrl, useStorageHeaders, versionOf } from "@/lib/drive-preview.ts";
import type { DriveNode } from "@/lib/drive.ts";
import { colors } from "@/theme/tokens.ts";

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 280;

type Size = Pick<LayoutRectangle, "width" | "height">;

/**
 * Images as Photos shows them: one a page, swiped sideways through the folder's images; pinch or
 * double tap to zoom, and pan a zoomed image up to its edge before the next one takes over. The
 * zoom is UIKit's own (a zooming `UIScrollView` per page), on images decoded at full size so a
 * zoomed photo stays sharp.
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
            if (node) props.onChange(node);
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
      }}
    >
      <Pressable onPress={onPress} accessibilityRole="image" accessibilityLabel={node.name}>
        <Image
          source={{ uri: contentUrl(node.id), headers, cacheKey: `${node.id}:${versionOf(node)}` }}
          style={size}
          contentFit="contain"
          allowDownscaling={false}
          transition={150}
          recyclingKey={node.id}
          onError={() => setFailed(true)}
        />
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
});
