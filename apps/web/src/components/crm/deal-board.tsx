// The deals board (ADR 0039 decision 1), after Attio's and Square's pipelines: one column per
// stage, in the pipeline's order, on a sunk ground; each deal a raised card with its name and
// value. Dragging a card to another column moves the deal there at once (`useMoveDeal` patches
// every deals list) and puts it back if the request fails. React Aria's drag and drop gives it
// the keyboard and screen readers too: a focused card's handle starts a move.
//
// Geometry: columns are 272px with 8px between them and 20px from the page's edges (the header's
// gutter); a column's 8px padding holds its cards 8px apart, so a card's 12px padding puts its
// text 20px in from the column's edge, under the column's title.
import {
  useDragAndDrop,
  type DragAndDropHooks,
  type DropItem,
} from "react-aria-components/useDragAndDrop";
import { Skeleton, SkeletonBox } from "skullet/react";
import { ListFailed } from "@/components/inbox/thread-list";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { useCrmStages, useMoveDeal } from "@/hooks/use-crm.ts";
import { formatMoney, type CrmDeal, type CrmStage } from "@/lib/crm.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

/** The drag type a card carries: the deal's id. */
const DEAL_TYPE = "application/x-omni-deal";

export function DealBoard(props: {
  deals: CrmDeal[];
  list: { isPending: boolean; isError: boolean; refetch: () => unknown };
}) {
  const stages = useCrmStages();
  if (props.list.isPending || stages.isPending) {
    return (
      <Skeleton loading label="Loading deals" skeleton={<BoardBones />}>
        {null}
      </Skeleton>
    );
  }
  if (props.list.isError || stages.isError || !stages.data) {
    return (
      <div className="flex h-full flex-col">
        <ListFailed
          retry={() => {
            void props.list.refetch();
            void stages.refetch();
          }}
        />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-5 py-4">
      {stages.data.map((stage) => (
        <Column
          key={stage.id}
          stage={stage}
          deals={props.deals.filter((deal) => deal.stageId === stage.id)}
        />
      ))}
    </div>
  );
}

function Column({ stage, deals }: { stage: CrmStage; deals: CrmDeal[] }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const dragAndDropHooks = useColumnDragAndDrop(stage, deals);
  const total = sumValues(deals);
  return (
    <section
      aria-label={stage.name}
      className="flex w-68 shrink-0 flex-col rounded-xl bg-secondary/60"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-5 text-sm">
        <span className="truncate">{stage.name}</span>
        <span className="text-muted-foreground tabular-nums">{deals.length}</span>
        {total && (
          <span className="ms-auto truncate text-muted-foreground tabular-nums">{total}</span>
        )}
      </header>
      <GridList
        aria-label={`Deals in ${stage.name}`}
        items={deals}
        dragAndDropHooks={dragAndDropHooks}
        layout="stack"
        className="min-h-24 flex-1 gap-2 overflow-y-auto rounded-b-xl bg-transparent p-2 pt-0 drop-target:bg-hover"
        renderEmptyState={() => null}
      >
        {(deal) => (
          <GridListItem
            id={deal.id}
            textValue={deal.name}
            href={inWorkspace(`/crm/deals/${encodeURIComponent(deal.id)}`)}
            className="flex-col items-stretch gap-0.5 rounded-lg border bg-background px-3 py-2.5 shadow-(--shadow-raised) transition-colors duration-150 ease-out hover:border-muted-foreground/30"
          >
            <span className="truncate text-sm">{deal.name}</span>
            <span className="truncate text-xs/4 text-muted-foreground tabular-nums">
              {formatMoney(deal.valueMinor, deal.valueCurrency) ?? "–"}
            </span>
          </GridListItem>
        )}
      </GridList>
    </section>
  );
}

/** A column's cards drag out, and cards from any column drop in (on a card or between them). */
function useColumnDragAndDrop(stage: CrmStage, deals: CrmDeal[]) {
  const move = useMoveDeal();
  const take = async (items: DropItem[]) => {
    for (const item of items) {
      if (item.kind !== "text" || !item.types.has(DEAL_TYPE)) continue;
      const dealId = await item.getText(DEAL_TYPE);
      if (deals.some((deal) => deal.id === dealId)) continue;
      move.mutate(
        { dealId, stage },
        { onError: (error) => crmErrorToast(error, "The deal was not moved") },
      );
    }
  };
  const { dragAndDropHooks } = useDragAndDrop<CrmDeal>({
    getItems: (keys, items) =>
      items
        .filter((deal) => keys.has(deal.id))
        .map((deal) => ({ [DEAL_TYPE]: deal.id, "text/plain": deal.name })),
    acceptedDragTypes: [DEAL_TYPE],
    getDropOperation: () => "move",
    onRootDrop: (event) => void take(event.items),
    onInsert: (event) => void take(event.items),
    onItemDrop: (event) => void take(event.items),
  });
  return dragAndDropHooks satisfies DragAndDropHooks<CrmDeal>;
}

/** The column's total, when its deals with a value share one currency. */
function sumValues(deals: CrmDeal[]) {
  const valued = deals.filter((deal) => deal.valueMinor !== null);
  if (!valued.length) return null;
  const currency = valued[0]?.valueCurrency ?? null;
  if (valued.some((deal) => deal.valueCurrency !== currency)) return null;
  return formatMoney(
    valued.reduce((sum, deal) => sum + (deal.valueMinor ?? 0), 0),
    currency,
  );
}

function BoardBones() {
  return (
    <div className="flex gap-2 px-5 py-4">
      {Array.from({ length: 5 }, (_, column) => (
        <div key={column} className="flex w-68 shrink-0 flex-col gap-2 rounded-xl p-2">
          <div className="flex h-8 items-center px-3">
            <SkeletonBox width={72} height={10} />
          </div>
          {Array.from({ length: 3 - (column % 3) }, (__, card) => (
            <SkeletonBox key={card} width="100%" height={52} radius="var(--radius-lg)" />
          ))}
        </div>
      ))}
    </div>
  );
}
