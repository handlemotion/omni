import { useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconTrash, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  useDeleteDeliverable,
  useDeleteMilestone,
  useUpdateDeliverable,
  useUpdateMilestone,
} from "@/hooks/use-crm-project.ts";
import {
  DELIVERABLE_STATUSES,
  MILESTONE_STATUSES,
  type CrmDeliverable,
  type CrmMilestone,
} from "@/lib/crm-project.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { ChoiceValue, DayValue, FieldRow, PlainValue, TextValue } from "./record-fields.tsx";
import { DAY } from "./record-list.tsx";

const NONE = "none";

/** The milestone or deliverable open beside the plan (`?plan=`): its link, and a way to close it. */
export function useOpenPlanItem() {
  const router = useRouter();
  const { plan } = useSearch({ strict: false }) as { plan?: string };
  const at = useCallback(
    (id: string | undefined) =>
      router.buildLocation({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, plan: id })) as never,
      }).href,
    [router],
  );
  return useMemo(
    () => ({
      id: plan ?? null,
      href: (id: string) => at(id),
      close: () => void router.history.push(at(undefined)),
    }),
    [plan, at, router],
  );
}

export type PlanItem =
  | { kind: "milestone"; milestone: CrmMilestone }
  | { kind: "deliverable"; deliverable: CrmDeliverable };

/** A milestone or deliverable beside the plan, as an open task sits beside its list. */
export function PlanPanel(props: {
  item: PlanItem;
  milestones: CrmMilestone[];
  onClose: () => void;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "Escape" || target?.closest("input, textarea, [role=dialog]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const label = props.item.kind === "milestone" ? "Milestone" : "Deliverable";
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col border-s bg-background max-lg:border-s-0 lg:w-96 lg:shrink-0"
    >
      {props.item.kind === "milestone" ? (
        <MilestoneDetails milestone={props.item.milestone} onClose={onClose} />
      ) : (
        <DeliverableDetails
          deliverable={props.item.deliverable}
          milestones={props.milestones}
          onClose={onClose}
        />
      )}
    </section>
  );
}

function MilestoneDetails(props: { milestone: CrmMilestone; onClose: () => void }) {
  const { milestone } = props;
  const update = useUpdateMilestone();
  const remove = useDeleteMilestone();
  const save = (change: Omit<Parameters<typeof update.mutate>[0], "id">) =>
    update.mutate(
      { id: milestone.id, ...change },
      { onError: (error) => crmErrorToast(error, "The milestone was not changed") },
    );
  return (
    <>
      <PanelHeader
        title={milestone.title}
        kind="milestone"
        onClose={props.onClose}
        deleting={remove.isPending}
        onDelete={() =>
          remove.mutate(milestone.id, {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "The milestone was not deleted"),
          })
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
        <Description
          key={milestone.id}
          value={milestone.description}
          onSave={(d) => save({ description: d })}
        />
        <div className="flex flex-col gap-0.5">
          <TextValue
            label="Title"
            required
            maxLength={300}
            value={milestone.title}
            onSave={(title) => title && save({ title })}
          />
          <ChoiceValue
            label="Status"
            value={milestone.status}
            options={MILESTONE_STATUSES.map((s) => ({ id: s.id, name: s.label }))}
            onSave={(status) => save({ status: status as CrmMilestone["status"] })}
          />
          <DayValue
            label="Target"
            value={milestone.targetOn}
            onSave={(targetOn) => save({ targetOn })}
          />
          <PlainValue label="Created">{DAY.format(new Date(milestone.createdAt))}</PlainValue>
        </div>
      </div>
    </>
  );
}

function DeliverableDetails(props: {
  deliverable: CrmDeliverable;
  milestones: CrmMilestone[];
  onClose: () => void;
}) {
  const { deliverable } = props;
  const update = useUpdateDeliverable();
  const remove = useDeleteDeliverable();
  const save = (change: Omit<Parameters<typeof update.mutate>[0], "id">) =>
    update.mutate(
      { id: deliverable.id, ...change },
      { onError: (error) => crmErrorToast(error, "The deliverable was not changed") },
    );
  return (
    <>
      <PanelHeader
        title={deliverable.title}
        kind="deliverable"
        onClose={props.onClose}
        deleting={remove.isPending}
        onDelete={() =>
          remove.mutate(deliverable.id, {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "The deliverable was not deleted"),
          })
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
        <Description
          key={deliverable.id}
          value={deliverable.description}
          onSave={(d) => save({ description: d })}
        />
        <div className="flex flex-col gap-0.5">
          <TextValue
            label="Title"
            required
            maxLength={300}
            value={deliverable.title}
            onSave={(title) => title && save({ title })}
          />
          <ChoiceValue
            label="Status"
            value={deliverable.status}
            options={DELIVERABLE_STATUSES.map((s) => ({ id: s.id, name: s.label }))}
            onSave={(status) => save({ status: status as CrmDeliverable["status"] })}
          />
          <ChoiceValue
            label="Milestone"
            value={deliverable.milestoneId ?? NONE}
            options={[
              ...props.milestones.map((m) => ({ id: m.id, name: m.title })),
              { id: NONE, name: "None" },
            ]}
            onSave={(id) => save({ milestoneId: id === NONE ? null : id })}
          />
          <DayValue label="Due" value={deliverable.dueOn} onSave={(dueOn) => save({ dueOn })} />
          <FieldRow label="Client">
            <span className="px-2">
              <CheckboxField
                isSelected={deliverable.clientVisible}
                onChange={(clientVisible) => save({ clientVisible })}
              >
                <Checkbox>Show to client</Checkbox>
              </CheckboxField>
            </span>
          </FieldRow>
          {deliverable.reviewNote && (
            <PlainValue label="Client note">{deliverable.reviewNote}</PlainValue>
          )}
          {deliverable.reviewedByEmail && (
            <PlainValue label="Reviewed by">{deliverable.reviewedByEmail}</PlainValue>
          )}
          <PlainValue label="Created">{DAY.format(new Date(deliverable.createdAt))}</PlainValue>
        </div>
      </div>
    </>
  );
}

function Description(props: { value: string | null; onSave: (value: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      plain
      aria-label="Notes"
      maxLength={10_000}
      placeholder="Notes"
      value={draft ?? props.value ?? ""}
      onChange={(event) => setDraft(event.target.value)}
      className="field-sizing-content min-h-16 w-full resize-none rounded-md px-2 py-1.5 text-sm hover:bg-hover focus:bg-hover sm:px-2"
      onBlur={() => {
        if (draft === null) return;
        setDraft(null);
        const next = draft.trim() || null;
        if (next !== (props.value ?? null)) props.onSave(next);
      }}
    />
  );
}

function PanelHeader(props: {
  title: string;
  kind: "milestone" | "deliverable";
  onClose: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2.5">
      <h2 className="min-w-0 flex-1 truncate text-md text-foreground">{props.title}</h2>
      <Button
        intent="plain"
        size="sq-sm"
        aria-label={`Delete ${props.kind}`}
        isPending={props.deleting}
        onPress={props.onDelete}
      >
        <IconTrash />
      </Button>
      <Button
        intent="plain"
        size="sq-sm"
        aria-label={`Close ${props.kind}`}
        onPress={props.onClose}
      >
        <IconX />
      </Button>
    </div>
  );
}
