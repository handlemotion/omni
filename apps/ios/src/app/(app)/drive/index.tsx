import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import {
  DRIVE_COLUMNS,
  DriveCardsRow,
  DriveList,
  DriveSkeleton,
} from "@/components/drive/drive-list.tsx";
import { DriveSearch } from "@/components/drive/drive-search.tsx";
import { TrashItem } from "@/components/drive/node-item.tsx";
import { DownloadsPanel } from "@/components/drive/downloads-panel.tsx";
import { UploadsPanel } from "@/components/drive/uploads-panel.tsx";
import { IconClock3, IconTrash } from "@/components/icons.ts";
import { useMenu } from "@/components/shell/menu-context.tsx";
import { useTopInset } from "@/components/shell/menu-nav.ts";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { LoadingPage } from "@/components/ui/loading-page.tsx";
import { useScrollEdge } from "@/components/ui/scroll-edge.tsx";
import {
  DRIVE_PAGES,
  drivePageIn,
  useRecentFiles,
  useSharedWithMe,
  useTrash,
  type DriveNode,
} from "@/lib/drive.ts";
import { useDebounced } from "@/lib/use-debounced.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { colors, floatingFade, space } from "@/theme/tokens.ts";

const CLEAR_OF_FADE = floatingFade - space(8);

/** A Drive page: Recents, a teamspace or legacy space, or Trash, matching the web's `StorageNav`. */
export default function DriveHome() {
  const params = useLocalSearchParams<{ page?: string; space?: string }>();
  const company = hasCrm(useWorkspace().active);
  const page = drivePageIn(params.page, company);
  const typed = useMenu().query.trim();
  const q = useDebounced(typed);
  return (
    <ModuleRoot module="drive">
      {typed ? (
        <DriveSearch q={q} footerSpace={CLEAR_OF_FADE} />
      ) : params.space ? (
        <Teamspace id={params.space} />
      ) : page === "trash" ? (
        <Trash />
      ) : page === "my" || page === "shared" ? (
        <Space space={page === "shared" ? "shared" : "personal"} />
      ) : (
        <Recents />
      )}
      <UploadsPanel />
      <DownloadsPanel />
    </ModuleRoot>
  );
}

function Teamspace({ id }: { id: string }) {
  return (
    <DriveList
      key={`t:${id}`}
      place={{ teamspace: id }}
      empty={DRIVE_PAGES.my.empty}
      footerSpace={CLEAR_OF_FADE}
    />
  );
}

function Space({ space: where }: { space: "personal" | "shared" }) {
  return (
    <DriveList
      key={where}
      place={{ space: where }}
      empty={DRIVE_PAGES.my.empty}
      footerSpace={CLEAR_OF_FADE}
    />
  );
}

function chunk(nodes: DriveNode[]) {
  const rows: { key: string; nodes: DriveNode[] }[] = [];
  for (let at = 0; at < nodes.length; at += DRIVE_COLUMNS) {
    const slice = nodes.slice(at, at + DRIVE_COLUMNS);
    rows.push({ key: `r:${slice[0]?.id}`, nodes: slice });
  }
  return rows;
}

function Recents() {
  const headerSpace = useTopInset();
  const recent = useRecentFiles();
  const shared = useSharedWithMe();
  const onScroll = useScrollEdge();
  const rows = useMemo(() => {
    const own = recent.data ?? [];
    const seen = new Set(own.map((node) => node.id));
    const theirs = (shared.data ?? [])
      .map((item) => item.node)
      .filter((node) => !seen.has(node.id));
    const merged = [...own, ...theirs].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    return chunk(merged);
  }, [recent.data, shared.data]);

  const retry = () => {
    void recent.refetch();
    void shared.refetch();
  };

  if (recent.isPending || shared.isPending) {
    return (
      <LoadingPage>
        <View style={{ paddingTop: headerSpace }}>
          <DriveSkeleton />
        </View>
      </LoadingPage>
    );
  }
  if (!rows.length) {
    const failed = (recent.isError || shared.isError) && !recent.data;
    return (
      <View style={styles.fill}>
        <EmptyState
          icon={IconClock3}
          title={failed ? "This list didn't load" : DRIVE_PAGES.recents.empty}
        >
          {failed ? <Button intent="plain" label="Try again" onPress={retry} /> : null}
        </EmptyState>
      </View>
    );
  }
  return (
    <FlashList
      contentInsetAdjustmentBehavior={headerSpace > 0 ? "never" : "automatic"}
      onScroll={onScroll}
      scrollEventThrottle={16}
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => <DriveCardsRow nodes={item.nodes} />}
      contentContainerStyle={{
        paddingTop: headerSpace + space(2),
        paddingBottom: space(8) + CLEAR_OF_FADE,
      }}
      refreshControl={
        <RefreshControl
          refreshing={recent.isRefetching || shared.isRefetching}
          onRefresh={retry}
          tintColor={colors.mutedForeground}
        />
      }
    />
  );
}

function Trash() {
  const query = useTrash();
  return (
    <InfiniteList
      query={query}
      keyOf={(node) => node.id}
      renderItem={(node) => <TrashItem node={node} />}
      icon={IconTrash}
      empty={DRIVE_PAGES.trash.empty}
      footerSpace={CLEAR_OF_FADE}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
