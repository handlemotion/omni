import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { useState } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { IconPlus } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCrmStages, useMoveDeal } from "@/hooks/use-crm.ts";
import { formatMoney, type CrmDeal, type CrmStage } from "@/lib/crm.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { DealCard, LiftedDealCard } from "./deal-card.tsx";
import { NewDealDialog } from "./new-records.tsx";

const COLUMN = "flex w-72 shrink-0 flex-col";
const COLUMN_STEP = 288 + 12;
const ARROW_STEPS: Record<string, number> = { ArrowRight: COLUMN_STEP, ArrowLeft: -COLUMN_STEP };
const SPACE_ONLY = { start: ["Space"], cancel: ["Escape"], end: ["Space"] };

const byPointerOrCenter: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

const stepColumns: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
  const step = ARROW_STEPS[event.code];
  if (!step) return undefined;
  event.preventDefault();
  return { ...currentCoordinates, x: currentCoordinates.x + step };
};

export function DealBoard(props: {
  deals: CrmDeal[];
  list: { isPending: boolean; isError: boolean; refetch: () => unknown };
}) {
  const stages = useCrmStages();
  const [adding, setAdding] = useState<string | null>(null);
  const drag = useBoardDrag(props.deals, stages.data ?? []);
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
    <DndContext
      sensors={drag.sensors}
      collisionDetection={byPointerOrCenter}
      onDragStart={drag.start}
      onDragEnd={drag.end}
      onDragCancel={drag.cancel}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-auto px-5 py-4">
        {stages.data.map((stage) => (
          <Column
            key={stage.id}
            stage={stage}
            deals={props.deals.filter((deal) => deal.stageId === stage.id)}
            lifted={drag.lifted}
            onAdd={() => setAdding(stage.id)}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {drag.lifted && <LiftedDealCard deal={drag.lifted} />}
      </DragOverlay>
      {adding && <NewDealDialog stageId={adding} onClose={() => setAdding(null)} />}
    </DndContext>
  );
}

function useBoardDrag(deals: CrmDeal[], stages: CrmStage[]) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { keyboardCodes: SPACE_ONLY, coordinateGetter: stepColumns }),
  );
  const move = useMoveDeal();
  const [lifted, setLifted] = useState<CrmDeal | null>(null);
  const start = (event: DragStartEvent) =>
    setLifted(deals.find((deal) => deal.id === event.active.id) ?? null);
  const end = (event: DragEndEvent) => {
    setLifted(null);
    const deal = deals.find((each) => each.id === event.active.id);
    const stage = stages.find((each) => each.id === event.over?.id);
    if (!deal || !stage || deal.stageId === stage.id) return;
    move.mutate(
      { dealId: deal.id, stage },
      { onError: (error) => crmErrorToast(error, "The deal was not moved") },
    );
  };
  return { sensors, lifted, start, end, cancel: () => setLifted(null) };
}

function Column(props: {
  stage: CrmStage;
  deals: CrmDeal[];
  lifted: CrmDeal | null;
  onAdd: () => void;
}) {
  const { stage, deals } = props;
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = sumValues(deals);
  const taking = isOver && !!props.lifted && props.lifted.stageId !== stage.id;
  return (
    <section
      ref={setNodeRef}
      aria-label={stage.name}
      data-taking={taking || undefined}
      className={`${COLUMN} rounded-xl p-1 transition-colors duration-150 ease-out data-taking:bg-hover`}
    >
      <header className="mb-1 flex h-9 shrink-0 items-center gap-2 text-sm">
        <span className="truncate">{stage.name}</span>
        <Badge
          intent="secondary"
          isCircle={false}
          className="h-5 min-w-5 justify-center px-1.5 py-0 text-xs/none tabular-nums"
        >
          {deals.length}
        </Badge>
        {total && (
          <span className="ms-auto truncate text-muted-foreground tabular-nums">{total}</span>
        )}
      </header>
      <ul aria-label={`Deals in ${stage.name}`} className="flex flex-col gap-2">
        {deals.map((deal) => (
          <DraggableDeal key={deal.id} deal={deal} />
        ))}
      </ul>
      <Button
        intent="ghost"
        className={`w-full justify-start ${deals.length ? "mt-2" : ""}`}
        onPress={props.onAdd}
      >
        <IconPlus data-slot="icon" />
        Add deal
      </Button>
    </section>
  );
}

function DraggableDeal({ deal }: { deal: CrmDeal }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: deal.id });
  return (
    <li
      ref={setNodeRef}
      onPointerDownCapture={listeners?.onPointerDown as React.PointerEventHandler | undefined}
      onKeyDownCapture={listeners?.onKeyDown as React.KeyboardEventHandler | undefined}
      className={`flex flex-col ${isDragging ? "opacity-0" : ""}`}
    >
      <DealCard deal={deal} />
    </li>
  );
}

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
    <div className="flex gap-3 px-5 py-4">
      {Array.from({ length: 5 }, (_, column) => (
        <div key={column} className={`${COLUMN} gap-2 p-1`}>
          <div className="mb-1 flex h-9 items-center">
            <SkeletonBox width={72} height={10} />
          </div>
          {Array.from({ length: 3 - (column % 3) }, (__, card) => (
            <SkeletonBox key={card} width="100%" height={68} radius="var(--radius-xl)" />
          ))}
        </div>
      ))}
    </div>
  );
}
