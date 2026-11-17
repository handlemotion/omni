import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import type { ComponentType, ReactElement } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import type { SvgProps } from "react-native-svg";
import { colors, space } from "@/theme/tokens.ts";
import { Button } from "./button.tsx";
import { EmptyState } from "./empty-state.tsx";
import { ListSkeleton } from "./list-skeleton.tsx";

type Glyph = ComponentType<SvgProps & { size?: number }>;

/**
 * A paged list under a native header: rows skeletons while the first page loads, a retry when
 * it fails, `empty` when it has nothing, more as you scroll, pull to refresh. The query's
 * `select` must hand back the flat array of rows.
 */
export function InfiniteList<T>(props: {
  query: UseInfiniteQueryResult<T[]>;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactElement;
  icon: Glyph;
  empty: string;
  /** Inset hairlines past a leading glyph, in points. */
  separatorInset?: number;
}) {
  const { query } = props;
  if (query.isPending) return <ListSkeleton />;
  if (query.isError && !query.data) {
    return (
      <EmptyState icon={props.icon} title="This list didn't load">
        <Button intent="plain" label="Try again" onPress={() => void query.refetch()} />
      </EmptyState>
    );
  }
  const inset = props.separatorInset ?? space(4);
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      data={query.data}
      keyExtractor={props.keyOf}
      renderItem={({ item }) => props.renderItem(item)}
      ItemSeparatorComponent={() => <View style={[styles.separator, { marginLeft: inset }]} />}
      contentContainerStyle={query.data.length ? null : styles.fill}
      ListEmptyComponent={<EmptyState icon={props.icon} title={props.empty} />}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching && !query.isFetchingNextPage}
          onRefresh={() => void query.refetch()}
          tintColor={colors.mutedForeground}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  fill: { flexGrow: 1 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
});
