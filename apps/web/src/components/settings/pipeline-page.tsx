// The CRM's pipeline (ADR 0036, ADR 0039 decision 1), for owners and admins: its stages in order,
// each with a free name and a fixed kind (open, won, done, lost). Every change replaces the whole
// list (`PUT /api/crm/stages`): rename, add, move up or down, remove. The API keeps a stage that
// still holds deals and at least one stage of each kind, and says so when refused.
import { useState } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { IconArrowUp, IconChevronDown, IconPencil, IconTrash } from "@/components/icons/central";
import { crmErrorToast } from "@/components/crm/crm-errors";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { useCrmStages, usePutStages } from "@/hooks/use-crm.ts";
import type { CrmStage, CrmStageKind } from "@/lib/crm.ts";
import type { StageInput } from "@/lib/crm-mutations.ts";
import { SettingsAddRow } from "./kit/settings-add-row";
import { SettingsGroup, SettingsSection, SettingsSections } from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu, type SettingsRowMenuItem } from "./kit/settings-row-menu";
import { SettingsFormDialog, SettingsRenameDialog } from "./kit/settings-stacked-dialog";

const KINDS: { id: CrmStageKind; name: string }[] = [
  { id: "open", name: "Open" },
  { id: "won", name: "Won" },
  { id: "done", name: "Done" },
  { id: "lost", name: "Lost" },
];
const KIND_INTENT = { open: "secondary", won: "success", done: "success", lost: "danger" } as const;

const STAGE_MAX = 200;

/** An existing stage as `PUT` takes it: its id keeps its kind. */
const asInput = (stage: CrmStage): StageInput => ({ id: stage.id, name: stage.name });

type Dialog = { kind: "rename"; stage: CrmStage } | { kind: "add" } | null;

export function PipelinePage() {
  const stages = useCrmStages();
  const put = usePutStages();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const list = stages.data ?? [];
  const replace = (next: StageInput[], then?: () => void) =>
    put.mutate(next, {
      onSuccess: then,
      onError: (error) => crmErrorToast(error, "The stages were not saved"),
    });
  const swap = (index: number, by: number) => {
    const next = list.map(asInput);
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(index + by, 0, moved);
    replace(next);
  };
  const menu = (stage: CrmStage, index: number): SettingsRowMenuItem[] => [
    { icon: IconPencil, label: "Rename", onAction: () => setDialog({ kind: "rename", stage }) },
    ...(index > 0
      ? [{ icon: IconArrowUp, label: "Move up", onAction: () => swap(index, -1) }]
      : []),
    ...(index < list.length - 1
      ? [{ icon: IconChevronDown, label: "Move down", onAction: () => swap(index, 1) }]
      : []),
    {
      icon: IconTrash,
      label: "Remove",
      danger: true,
      onAction: () => replace(list.filter((s) => s.id !== stage.id).map(asInput)),
    },
  ];
  return (
    <SettingsSections>
      <SettingsSection title="Stages">
        {stages.isPending ? (
          <Skeleton
            loading
            label="Loading stages"
            skeleton={<SkeletonBox width="100%" height={232} radius="var(--radius-xl)" />}
          >
            {null}
          </Skeleton>
        ) : (
          <SettingsGroup>
            {list.map((stage, index) => (
              <SettingsRow
                key={stage.id}
                label={stage.name}
                control={
                  <>
                    <Badge intent={KIND_INTENT[stage.kind]}>
                      {KINDS.find((k) => k.id === stage.kind)?.name}
                    </Badge>
                    <SettingsRowMenu
                      label={`Actions for ${stage.name}`}
                      items={menu(stage, index)}
                      disabled={put.isPending}
                    />
                  </>
                }
              />
            ))}
            <SettingsAddRow label="Add stage" onPress={() => setDialog({ kind: "add" })} />
          </SettingsGroup>
        )}
      </SettingsSection>
      {dialog?.kind === "rename" && (
        <SettingsRenameDialog
          title="Rename stage"
          label="Name"
          maxLength={STAGE_MAX}
          name={dialog.stage.name}
          saving={put.isPending}
          onClose={close}
          onSave={(name) =>
            replace(
              list.map((s) => (s.id === dialog.stage.id ? { id: s.id, name } : asInput(s))),
              close,
            )
          }
        />
      )}
      {dialog?.kind === "add" && (
        <AddStageDialog
          saving={put.isPending}
          onClose={close}
          onAdd={(stage) => replace([...list.map(asInput), stage], close)}
        />
      )}
    </SettingsSections>
  );
}

function AddStageDialog(props: {
  saving: boolean;
  onAdd: (stage: { name: string; kind: CrmStageKind }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CrmStageKind>("open");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Add stage"
      action="Add"
      disabled={!name.trim()}
      saving={props.saving}
      onSubmit={() => props.onAdd({ name: name.trim(), kind })}
    >
      <TextField isRequired autoFocus maxLength={STAGE_MAX} value={name} onChange={setName}>
        <Label>Name</Label>
        <Input autoComplete="off" />
      </TextField>
      <Select value={kind} onChange={(next) => next && setKind(next as CrmStageKind)}>
        <Label>Kind</Label>
        <SelectTrigger />
        <SelectContent items={KINDS}>
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              {item.name}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </SettingsFormDialog>
  );
}
