import { FlashList } from "@shopify/flash-list";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { useMemo, type ComponentType, type ReactElement } from "react";
import { RefreshControl, ScrollView, StyleSheet } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, space } from "@/theme/tokens.ts";
import { Button } from "./button.tsx";
import { EmptyState } from "./empty-state.tsx";
import { ListSkeleton } from "./list-skeleton.tsx";

type Glyph = ComponentType<SvgProps & { size?: number }>;

interface Paged<T, R> {
  query: UseInfiniteQueryResult<T[]>;
  /** The rows to draw from the loaded items (headings between them), when not the items as they are. */
  rows?: (items: T[]) => R[];
  keyOf: (row: R) => string;
  renderItem: (row: R) => ReactElement;
  /** Tells rows of different shapes apart (a day's heading, a thread), so they recycle apart. */
  typeOf?: (row: R) => string;
  icon: Glyph;
  empty: string;
  /** Drawn instead of `ListSkeleton` while the first page loads. */
  skeleton?: ReactElement;
}

/**
 * A paged list under a native header, on FlashList (rows recycle, so a long list scrolls at
 * frame rate): skeleton rows while the first page loads, a retry when it fails, `empty` when it
 * has nothing, more as you scroll, pull to refresh. The query's `select` must hand back the
 * flat array of rows.
 */
export function InfiniteList<T, R = T>(props: Paged<T, R>) {
  const { query, rows: toRows } = props;
  const rows = useMemo(
    () => (query.data ? (toRows ? toRows(query.data) : (query.data as unknown as R[])) : []),
    [query.data, toRows],
  );
  if (query.isPending) return props.skeleton ?? <ListSkeleton />;
  const refresh = (
    <RefreshControl
      refreshing={query.isRefetching && !query.isFetchingNextPage}
      onRefresh={() => void query.refetch()}
      tintColor={colors.mutedForeground}
    />
  );
  if (!rows.length) {
    const failed = query.isError && !query.data;
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.fill}
        refreshControl={refresh}
      >
        <EmptyState icon={props.icon} title={failed ? "This list didn't load" : props.empty}>
          {failed ? (
            <Button intent="plain" label="Try again" onPress={() => void query.refetch()} />
          ) : null}
        </EmptyState>
      </ScrollView>
    );
  }
  return (
    <FlashList
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      keyExtractor={props.keyOf}
      getItemType={props.typeOf}
      renderItem={({ item }) => props.renderItem(item)}
      contentContainerStyle={styles.list}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      refreshControl={refresh}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flexGrow: 1 },
  list: { paddingTop: space(1), paddingBottom: space(8) },
});
