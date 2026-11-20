import { useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import {
  IconArrowDown,
  IconRestore,
  IconArrowUp,
  IconCircle,
  IconCircleCheck,
  IconCircleDashed,
  IconLock,
  IconPencil,
  IconPlus,
  IconTrash,
  IconSend,
  IconUsers,
} from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import {
  useCreateDeliverable,
  useCreateMilestone,
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
import { RowWithMenu } from "./record-sections.tsx";

const dayLabel = (day: string | null) => (day ? dueLabel(`${day}T12:00:00`) : null);

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

const MILESTONE_INTENT = { planned: "secondary", in_progress: "info", done: "success" } as const;

const statusLabel = (list: { id: string; label: string }[], id: string) =>
  list.find((one) => one.id === id)?.label ?? id;

/** A project's plan: its milestones in order, each with its deliverables, then the rest. */
export function ProjectPlan(props: { dealId: string }) {
  const plan = useCrmPlan(props.dealId);
  const [adding, setAdding] = useState<"milestone" | "deliverable" | null>(null);
  const actions = (
    <div className="flex justify-end gap-2">
      <Button size="sm" intent="secondary" onPress={() => setAdding("deliverable")}>
        <IconPlus />
        New deliverable
      </Button>
      <Button size="sm" onPress={() => setAdding("milestone")}>
        <IconPlus />
        New milestone
      </Button>
    </div>
  );
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
  const loose = deliverables.filter((d) => !d.milestoneId);
  return (
    <div className="flex flex-col gap-4">
      {actions}
      {milestones.length === 0 && deliverables.length === 0 ? (
        <EmptyState figure="cabinet" title="No milestones" />
      ) : (
        <>
          {milestones.map((milestone, index) => (
            <MilestoneGroup
              key={milestone.id}
              milestone={milestone}
              index={index}
              last={index === milestones.length - 1}
              deliverables={deliverables.filter((d) => d.milestoneId === milestone.id)}
            />
          ))}
          {loose.length > 0 && (
            <section aria-label="No milestone" className="flex flex-col gap-1">
              <h3 className="flex h-8 items-center px-2 text-sm text-muted-foreground">
                No milestone
              </h3>
              <DeliverableRows deliverables={loose} />
            </section>
          )}
        </>
      )}
      {dialogs}
    </div>
  );
}

const NO_MILESTONE = "none";

function MilestoneGroup(props: {
  milestone: CrmMilestone;
  index: number;
  last: boolean;
  deliverables: CrmDeliverable[];
}) {
  const { milestone } = props;
  const update = useUpdateMilestone();
  const remove = useDeleteMilestone();
  const change = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, {
      onError: (error) => crmErrorToast(error, "The milestone was not changed"),
    });
  const target = dayLabel(milestone.targetOn);
  return (
    <section aria-label={milestone.title} className="flex flex-col gap-1">
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
            ...(props.index === 0
              ? []
              : [
                  {
                    id: "up",
                    label: "Move up",
                    icon: <IconArrowUp data-slot="icon" />,
                    onAction: () => change({ id: milestone.id, position: props.index - 1 }),
                  },
                ]),
            ...(props.last
              ? []
              : [
                  {
                    id: "down",
                    label: "Move down",
                    icon: <IconArrowDown data-slot="icon" />,
                    onAction: () => change({ id: milestone.id, position: props.index + 1 }),
                  },
                ]),
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
          <span className="flex h-8 min-w-0 items-center gap-2">
            <span className="truncate text-sm text-foreground">{milestone.title}</span>
            <Badge intent={MILESTONE_INTENT[milestone.status]} className="shrink-0">
              {statusLabel(MILESTONE_STATUSES, milestone.status)}
            </Badge>
            {target && (
              <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {target}
              </span>
            )}
          </span>
        </RowWithMenu>
      </div>
      <DeliverableRows deliverables={props.deliverables} />
    </section>
  );
}

function DeliverableRows(props: { deliverables: CrmDeliverable[] }) {
  if (!props.deliverables.length) return null;
  return (
    <ul className="flex flex-col">
      {props.deliverables.map((deliverable) => (
        <DeliverableRow key={deliverable.id} deliverable={deliverable} />
      ))}
    </ul>
  );
}

function DeliverableRow({ deliverable }: { deliverable: CrmDeliverable }) {
  const update = useUpdateDeliverable();
  const remove = useDeleteDeliverable();
  const change = (patch: Parameters<typeof update.mutate>[0]) =>
    update.mutate(patch, {
      onError: (error) => crmErrorToast(error, "The deliverable was not changed"),
    });
  const due = dayLabel(deliverable.dueOn);
  return (
    <li className="flex min-w-0 flex-col rounded-lg px-2 transition-colors duration-150 ease-out hover:bg-hover">
      <div className="flex h-10 min-w-0 items-center">
        <div className="min-w-0 flex-1">
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
                  change({ id: deliverable.id, clientVisible: !deliverable.clientVisible }),
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
            <span className="flex min-w-0 items-center gap-2 ps-6">
              <span className="truncate text-sm text-foreground">{deliverable.title}</span>
              <Badge intent={DELIVERABLE_INTENT[deliverable.status]} className="shrink-0">
                {statusLabel(DELIVERABLE_STATUSES, deliverable.status)}
              </Badge>
              {deliverable.clientVisible && (
                <Badge intent="outline" className="shrink-0">
                  Client
                </Badge>
              )}
              {due && (
                <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                  {due}
                </span>
              )}
            </span>
          </RowWithMenu>
        </div>
      </div>
      {deliverable.status === "changes_requested" && deliverable.reviewNote && (
        <p className="flex min-w-0 gap-1.5 ps-6 pb-2.5 text-sm">
          <span className="shrink-0 text-muted-foreground">{deliverable.reviewedByEmail}</span>
          <span className="whitespace-pre-wrap text-foreground">{deliverable.reviewNote}</span>
        </p>
      )}
    </li>
  );
}

function NewMilestoneDialog(props: { dealId: string; onClose: () => void }) {
  const create = useCreateMilestone();
  const [title, setTitle] = useState("");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="New milestone"
      action="Add"
      disabled={!title.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          { dealId: props.dealId, title: title.trim() },
          {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "The milestone was not added"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={300} value={title} onChange={setTitle}>
        <Label>Title</Label>
        <Input autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}

function NewDeliverableDialog(props: {
  dealId: string;
  milestones: CrmMilestone[];
  onClose: () => void;
}) {
  const create = useCreateDeliverable();
  const [title, setTitle] = useState("");
  const [milestoneId, setMilestoneId] = useState(props.milestones[0]?.id ?? NO_MILESTONE);
  const [clientVisible, setClientVisible] = useState(false);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="New deliverable"
      action="Add"
      disabled={!title.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            dealId: props.dealId,
            title: title.trim(),
            milestoneId: milestoneId === NO_MILESTONE ? null : milestoneId,
            clientVisible,
          },
          {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "The deliverable was not added"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={300} value={title} onChange={setTitle}>
        <Label>Title</Label>
        <Input autoComplete="off" />
      </TextField>
      {props.milestones.length > 0 && (
        <Select
          value={milestoneId}
          onChange={(id) => setMilestoneId(id ? String(id) : NO_MILESTONE)}
        >
          <Label>Milestone</Label>
          <SelectTrigger />
          <SelectContent items={[...props.milestones, { id: NO_MILESTONE, title: "None" }]}>
            {(milestone) => (
              <SelectItem id={milestone.id} textValue={milestone.title}>
                {milestone.title}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
      <CheckboxField isSelected={clientVisible} onChange={setClientVisible}>
        <Checkbox>Show to client</Checkbox>
      </CheckboxField>
    </SettingsFormDialog>
  );
}

function PlanBones() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 px-2">
          <span className="min-w-0 flex-1">
            <SkeletonBox width={`${30 + ((i * 17) % 40)}%`} height={10} />
          </span>
          <SkeletonBox width={48} height={10} />
        </div>
      ))}
    </div>
  );
}
