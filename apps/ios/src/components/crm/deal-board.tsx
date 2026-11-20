import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { IconHandshake } from "@/components/icons.ts";
import { FLOATING_BAR_SPACE } from "@/components/shell/floating-bar.tsx";
import { ChipButton } from "@/components/ui/chip-button.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useDeals, type CrmDeal } from "@/lib/crm.ts";
import type { ListView } from "@/lib/crm-lists.ts";
import { useStages } from "@/lib/crm-timeline.ts";
import { gutter, space } from "@/theme/tokens.ts";
import { DealItem, emptyText } from "./record-lists.tsx";

/**
 * The deal board on a phone, as Pipedrive's app draws it: the pipeline's stages as a row of
 * chips, each with how many deals it holds, over the deals of the stage picked. Every deal is
 * loaded, so each count is whole; a deal's menu moves it to another stage.
 */
export function DealBoard({ view }: { view: ListView }) {
  const query = useDeals({ ...view, stage: null }, { whole: true });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const stages = useStages().data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const stageId = stages.some((stage) => stage.id === picked) ? picked : (stages[0]?.id ?? null);
  const counts = new Map<string, number>();
  for (const deal of query.data ?? [])
    counts.set(deal.stageId, (counts.get(deal.stageId) ?? 0) + 1);
  const inStage = (deals: CrmDeal[]) => deals.filter((deal) => deal.stageId === stageId);
  return (
    <View style={styles.board}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stages}
        style={styles.bar}
      >
        {stages.map((stage) => (
          <ChipButton
            key={stage.id}
            variant="chip"
            label={stage.name}
            isSelected={stage.id === stageId}
            trailing={
              <Text size="subhead" tone="mutedForeground" tabular>
                {counts.get(stage.id) ?? 0}
              </Text>
            }
            onPress={() => setPicked(stage.id)}
          />
        ))}
      </ScrollView>
      <InfiniteList
        key={stageId ?? "none"}
        query={query}
        rows={inStage}
        keyOf={(deal) => deal.id}
        renderItem={(deal) => <DealItem deal={deal} />}
        icon={IconHandshake}
        empty={emptyText("deals", view)}
        footerSpace={FLOATING_BAR_SPACE}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  board: { flex: 1 },
  bar: { flexGrow: 0 },
  stages: { gap: space(2), paddingHorizontal: gutter, paddingBottom: space(2) },
});
