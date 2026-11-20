import { useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { useCreateDeliverable, useCreateMilestone } from "@/hooks/use-crm-project.ts";
import type { CrmMilestone } from "@/lib/crm-project.ts";
import { crmErrorToast } from "./crm-errors.ts";

const NO_MILESTONE = "none";

export function NewMilestoneDialog(props: { dealId: string; onClose: () => void }) {
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

export function NewDeliverableDialog(props: {
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
