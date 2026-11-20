import { useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import {
  IconArrowDown,
  IconRestore,
  IconArrowUp,
  IconCircle,
  IconCircleCheck,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconLock,
  IconPencil,
  IconPlus,
  IconTrash,
  IconSend,
  IconUsers,
} from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useCrmPlan,
  useDeleteDeliverable,
  useDeleteMilestone,
  useUpdateDeliverable,
  useUpdateMilestone,
} from "@/hooks/use-crm-project.ts";
import { dueLabel } from "@/lib/crm-tasks.ts";
import {
  DELIVERABLE_STATUSES,
  MILESTONE_STATUSES,
  type CrmDeliverable,
  type CrmDeliverableStatus,
  type CrmMilestone,
  type CrmMilestoneStatus,
} from "@/lib/crm-project.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { PlanPanel, useOpenPlanItem, type PlanItem } from "./plan-panel.tsx";
import { NewDeliverableDialog, NewMilestoneDialog } from "./project-plan-dialogs.tsx";
import { RailRow, railPlace, type RailPlace } from "./rail-row.tsx";
import { RowWithMenu } from "./record-sections.tsx";

const dayLabel = (day: string | null) => (day ? dueLabel(`${day}T12:00:00`) : null);

const isPast = (day: string | null) => !!day && day < new Date().toLocaleDateString("en-CA");

const MILESTONE_ICONS: Record<CrmMilestoneStatus, ReactNode> = {
  planned: <IconCircleDashed data-slot="icon" />,
  in_progress: <IconCircle data-slot="icon" />,
  done: <IconCircleCheck data-slot="icon" />,
};

const DELIVERABLE_ICONS: Record<CrmDeliverableStatus, ReactNode> = {
  draft: <IconPencil data-slot="icon" />,
  in_review: <IconSend data-slot="icon" />,
  approved: <IconCircleCheck data-slot="icon" />,
  changes_requested: <IconRestore data-slot="icon" />,
};

const DELIVERABLE_INTENT = {
  draft: "secondary",
  in_review: "info",
  approved: "success",
  changes_requested: "warning",
} as const;

const DELIVERABLE_DOT: Record<CrmDeliverableStatus, string> = {
  draft: "bg-subtle-foreground",
  in_review: "bg-info",
  approved: "bg-success",
  changes_requested: "bg-warning",
};

const statusLabel = (list: { id: string; label: string }[], id: string) =>
  list.find((one) => one.id === id)?.label ?? id;

type PlanRow =
  | { kind: "milestone"; milestone: CrmMilestone; index: number; count: number }
  | { kind: "loose" }
  | { kind: "deliverable"; deliverable: CrmDeliverable; open: boolean };

function planRows(milestones: CrmMilestone[], deliverables: CrmDeliverable[]) {
  const under = (milestone: CrmMilestone | null) =>
    deliverables
      .filter((d) => d.milestoneId === (milestone?.id ?? null))
      .map(
        (deliverable) =>
          ({
            kind: "deliverable",
            deliverable,
            open: milestone?.status !== "done",
          }) satisfies PlanRow,
      );
  const loose = under(null);
  const rows: PlanRow[] = [
    ...milestones.flatMap((milestone, index) => [
      {
        kind: "milestone",
        milestone,
        index,
        count: milestones.length,
      } satisfies PlanRow,
      ...under(milestone),
    ]),
    ...(loose.length ? [{ kind: "loose" } satisfies PlanRow, ...loose] : []),
  ];
  return rows;
}

/** A project's plan: its milestones as phases on a rail, each with its deliverables. */
export function ProjectPlan(props: { dealId: string }) {
  const plan = useCrmPlan(props.dealId);
  const opened = useOpenPlanItem();
  const [adding, setAdding] = useState<"milestone" | "deliverable" | null>(null);
  const dialogs = (
    <>
      {adding === "milestone" && (
        <NewMilestoneDialog dealId={props.dealId} onClose={() => setAdding(null)} />
      )}
      {adding === "deliverable" && (
        <NewDeliverableDialog
          dealId={props.dealId}
          milestones={plan.data?.milestones ?? []}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
  if (plan.isPending) {
    return (
      <Skeleton loading label="Loading the plan" skeleton={<PlanBones />}>
        {null}
      </Skeleton>
    );
  }
  if (plan.isError) return <ListFailed retry={() => void plan.refetch()} />;
  const { milestones, deliverables } = plan.data;
  const rows = planRows(milestones, deliverables);
  const item = openItem(opened.id, milestones, deliverables);
  const controls = (
    <div className="flex min-h-8 flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <PlanProgress milestones={milestones} />
      <div className="flex gap-2">
        <Button size="sm" intent="secondary" onPress={() => setAdding("deliverable")}>
          <IconPlus />
          New deliverable
        </Button>
        <Button size="sm" onPress={() => setAdding("milestone")}>
          <IconPlus />
          New milestone
        </Button>
      </div>
    </div>
  );
  const href = (id: string) => opened.href(id);
  return (
    <div className="flex min-w-0 gap-6 max-lg:flex-col">
      <div className={`flex min-w-0 flex-1 flex-col gap-6 ${item ? "max-lg:hidden" : ""}`}>
        {rows.length === 0 ? (
          <EmptyState figure="cabinet" title="No milestones" />
        ) : (
          <ol aria-label="Plan" className="group/rail flex flex-col">
            {rows.map((row, i) => {
              const place = railPlace(i, rows.length);
              switch (row.kind) {
                case "milestone":
                  return (
                    <MilestoneRow
                      key={row.milestone.id}
                      {...row}
                      place={place}
                      href={href(row.milestone.id)}
                      current={opened.id === row.milestone.id}
                    />
                  );
                case "loose":
                  return <LooseRow key="loose" place={place} />;
                case "deliverable":
                  return (
                    <DeliverableRow
                      key={row.deliverable.id}
                      deliverable={row.deliverable}
                      open={row.open}
                      place={place}
                      href={href(row.deliverable.id)}
                      current={opened.id === row.deliverable.id}
                    />
                  );
              }
            })}
          </ol>
        )}
        {controls}
      </div>
      {item && <PlanPanel item={item} milestones={milestones} onClose={opened.close} />}
      {dialogs}
    </div>
  );
}

function openItem(id: string | null, milestones: CrmMilestone[], deliverables: CrmDeliverable[]) {
  if (!id) return null;
  const milestone = milestones.find((m) => m.id === id);
  if (milestone) return { kind: "milestone", milestone } satisfies PlanItem;
  const deliverable = deliverables.find((d) => d.id === id);
  return deliverable ? ({ kind: "deliverable", deliverable } satisfies PlanItem) : null;
}

function PlanProgress({ milestones }: { milestones: CrmMilestone[] }) {
  if (!milestones.length) return null;
  const done = milestones.filter((m) => m.status === "done").length;
  return (
    <div className="me-auto flex min-w-0 items-center gap-3">
      <span className="flex w-40 gap-1" aria-hidden>
        {milestones.map((m) => (
          <span
            key={m.id}
            className={`h-1.5 min-w-0 flex-1 rounded-full ${
              m.status === "done"
                ? "bg-success"
                : m.status === "in_progress"
                  ? "bg-info"
                  : "bg-secondary"
            }`}
          />
        ))}
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {done} of {milestones.length} done
      </span>
    </div>
  );
}

function MilestoneMark({ status }: { status: CrmMilestoneStatus }) {
  const label = statusLabel(MILESTONE_STATUSES, status);
  const disc = "grid size-5 place-items-center rounded-full bg-background";
  if (status === "done") {
    return (
      <span role="img" aria-label={label} className={`${disc} text-success`}>
        <IconCircleCheckFilled className="size-4" />
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span role="img" aria-label={label} className={`${disc} relative text-info`}>
        <IconCircle className="size-4" />
        <span className="absolute size-1.5 rounded-full bg-info" />
      </span>
    );
  }
  return (
    <span role="img" aria-label={label} className={`${disc} text-subtle-foreground`}>
      <IconCircleDashed className="size-4" />
    </span>
  );
}

function MilestoneRow(props: {
  milestone: CrmMilestone;
  index: number;
  count: number;
  place: RailPlace;
  href: string;
  current: boolean;
}) {
  const { milestone, index } = props;
  const update = useUpdateMilestone();
  const remove = useDeleteMilestone();
  const change = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, {
      onError: (error) => crmErrorToast(error, "The milestone was not changed"),
    });
  const late = milestone.status !== "done" && isPast(milestone.targetOn);
  const move = (id: "up" | "down", to: number) => ({
    id,
    label: id === "up" ? "Move up" : "Move down",
    icon: id === "up" ? <IconArrowUp data-slot="icon" /> : <IconArrowDown data-slot="icon" />,
    onAction: () => change({ id: milestone.id, position: to }),
  });
  return (
    <RailRow
      opens
      place={props.place}
      href={props.href}
      label={milestone.title}
      current={props.current}
      mark={<MilestoneMark status={milestone.status} />}
      date={
        <span className={late ? "text-danger" : "text-foreground"}>
          {dayLabel(milestone.targetOn)}
        </span>
      }
    >
      <div className="px-2">
        <RowWithMenu
          label={milestone.title}
          actions={[
            ...MILESTONE_STATUSES.filter((s) => s.id !== milestone.status).map((s) => ({
              id: s.id,
              label: s.label,
              icon: MILESTONE_ICONS[s.id],
              onAction: () => change({ id: milestone.id, status: s.id }),
            })),
            ...(index === 0 ? [] : [move("up", index - 1)]),
            ...(index === props.count - 1 ? [] : [move("down", index + 1)]),
            {
              id: "delete",
              label: "Delete milestone",
              icon: <IconTrash data-slot="icon" />,
              danger: true,
              onAction: () =>
                remove.mutate(milestone.id, {
                  onError: (error) => crmErrorToast(error, "The milestone was not deleted"),
                }),
            },
          ]}
        >
          <span className="flex h-10 min-w-0 items-center">
            <span className="truncate text-sm text-foreground">{milestone.title}</span>
          </span>
        </RowWithMenu>
      </div>
    </RailRow>
  );
}

function LooseRow({ place }: { place: RailPlace }) {
  return (
    <RailRow
      opens
      place={place}
      mark={
        <span className="grid size-5 place-items-center rounded-full bg-background text-subtle-foreground">
          <IconCircleDashed className="size-4" />
        </span>
      }
    >
      <h3 className="flex h-10 items-center px-2 text-sm text-muted-foreground">No milestone</h3>
    </RailRow>
  );
}

function DeliverableRow(props: {
  deliverable: CrmDeliverable;
  open: boolean;
  place: RailPlace;
  href: string;
  current: boolean;
}) {
  const { deliverable } = props;
  const update = useUpdateDeliverable();
  const remove = useDeleteDeliverable();
  const change = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, {
      onError: (error) => crmErrorToast(error, "The deliverable was not changed"),
    });
  const late = props.open && deliverable.status !== "approved" && isPast(deliverable.dueOn);
  return (
    <RailRow
      place={props.place}
      href={props.href}
      label={deliverable.title}
      current={props.current}
      mark={
        <span
          className={`size-1.5 rounded-full ring-2 ring-background ${DELIVERABLE_DOT[deliverable.status]}`}
        />
      }
      date={
        <span className={late ? "text-danger" : "text-muted-foreground"}>
          {dayLabel(deliverable.dueOn)}
        </span>
      }
    >
      <div className="@container flex min-w-0 flex-col px-2">
        <RowWithMenu
          label={deliverable.title}
          actions={[
            ...DELIVERABLE_STATUSES.filter((s) => s.id !== deliverable.status).map((s) => ({
              id: s.id,
              label: s.label,
              icon: DELIVERABLE_ICONS[s.id],
              onAction: () => change({ id: deliverable.id, status: s.id }),
            })),
            {
              id: "visible",
              label: deliverable.clientVisible ? "Hide from client" : "Show to client",
              icon: deliverable.clientVisible ? (
                <IconLock data-slot="icon" />
              ) : (
                <IconUsers data-slot="icon" />
              ),
              onAction: () =>
                change({
                  id: deliverable.id,
                  clientVisible: !deliverable.clientVisible,
                }),
            },
            {
              id: "delete",
              label: "Delete deliverable",
              icon: <IconTrash data-slot="icon" />,
              danger: true,
              onAction: () =>
                remove.mutate(deliverable.id, {
                  onError: (error) => crmErrorToast(error, "The deliverable was not deleted"),
                }),
            },
          ]}
        >
          <span className="flex h-10 min-w-0 items-center gap-2">
            <span className="truncate text-sm text-foreground">{deliverable.title}</span>
            {deliverable.status !== "draft" && (
              <Badge
                intent={DELIVERABLE_INTENT[deliverable.status]}
                className="shrink-0 @max-md:hidden"
              >
                {statusLabel(DELIVERABLE_STATUSES, deliverable.status)}
              </Badge>
            )}
            {deliverable.clientVisible && (
              <Badge intent="outline" className="shrink-0 @max-md:hidden">
                Client
              </Badge>
            )}
          </span>
        </RowWithMenu>
      </div>
    </RailRow>
  );
}

function PlanBones() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="grid h-10 grid-cols-[4rem_1.25rem_minmax(0,1fr)] max-sm:grid-cols-[3.25rem_1.25rem_minmax(0,1fr)] max-sm:gap-x-2 items-center gap-x-3"
        >
          <span className="flex justify-start">
            <SkeletonBox width={36} height={10} />
          </span>
          <span className="flex justify-center">
            <SkeletonBox width={i % 3 ? 6 : 16} height={i % 3 ? 6 : 16} radius="999px" />
          </span>
          <span className="px-2">
            <SkeletonBox width={`${30 + ((i * 17) % 40)}%`} height={10} />
          </span>
        </div>
      ))}
    </div>
  );
}
