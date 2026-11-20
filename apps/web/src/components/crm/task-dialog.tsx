import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { ComboBox, ComboBoxContent, ComboBoxInput, ComboBoxItem } from "@/components/ui/combo-box";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ItemLabel } from "@/components/ui/dropdown";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { useCrmFind } from "@/hooks/use-crm.ts";
import { useCreateTask } from "@/hooks/use-crm-tasks.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { useSession } from "@/hooks/use-session.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import type { CrmRecordKind } from "@/lib/crm.ts";
import { dueAtOf, onRecord } from "@/lib/crm-tasks.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { MemberAvatar } from "./member-avatar.tsx";
import { NAME_MAX } from "./new-records.tsx";

/** The workspace's members as `{ id, name }`, for assignee pickers. */
export function useMemberNames() {
  const members = useMembers().data?.members;
  return useMemo(
    () =>
      (members ?? []).map((m) => ({
        id: m.id,
        name: m.user.name || m.user.email,
        image: m.user.image ?? null,
      })),
    [members],
  );
}

/** The signed-in person's member id in this workspace. */
export function useSelfMemberId() {
  const userId = useSession().data?.user.id;
  return useMembers().data?.members.find((m) => m.userId === userId)?.id ?? null;
}

const NOBODY = "nobody";

/** Assignee: a member, or nobody. `null` is nobody. */
export function AssigneePicker(props: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** In a details pane: no label and no border, as `ChoiceValue`. */
  inline?: boolean;
}) {
  const people = [...useMemberNames(), { id: NOBODY, name: "Nobody", image: null }];
  const chosen = people.find((person) => person.id === props.value);
  return (
    <Select
      aria-label="Assignee"
      value={props.value ?? NOBODY}
      onChange={(id) => props.onChange(!id || id === NOBODY ? null : String(id))}
    >
      {!props.inline && <Label>Assignee</Label>}
      <SelectTrigger
        className={
          props.inline
            ? "border-transparent bg-transparent enabled:hover:border-transparent enabled:hover:bg-hover"
            : undefined
        }
        leading={chosen && <MemberAvatar name={chosen.name} image={chosen.image} />}
      />
      <SelectContent items={people}>
        {(person) => (
          <SelectItem id={person.id} textValue={person.name}>
            {person.id !== NOBODY && <MemberAvatar name={person.name} image={person.image} />}
            <ItemLabel>{person.name}</ItemLabel>
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

export type PickedRecord = { kind: CrmRecordKind; id: string; name: string };

/** A company, person or deal, searched on the server as it is typed. */
export function RecordPicker(props: {
  value: PickedRecord | null;
  onChange: (record: PickedRecord | null) => void;
  label?: boolean;
}) {
  const [text, setText] = useState(props.value?.name ?? "");
  const q = useDebouncedValue(text.trim(), 200);
  const found = useCrmFind(q).data;
  const items: (PickedRecord & { key: string })[] = [
    ...(found?.companies ?? []).map((r) => ({
      kind: "companies" as const,
      id: r.id,
      name: r.name,
    })),
    ...(found?.people ?? []).map((r) => ({ kind: "people" as const, id: r.id, name: r.name })),
    ...(found?.deals ?? []).map((r) => ({ kind: "deals" as const, id: r.id, name: r.name })),
  ].map((r) => ({ ...r, key: `${r.kind}:${r.id}` }));
  return (
    <ComboBox
      selectedKey={props.value ? `${props.value.kind}:${props.value.id}` : null}
      onSelectionChange={(key) => {
        const picked = items.find((item) => item.key === key);
        props.onChange(picked ? { kind: picked.kind, id: picked.id, name: picked.name } : null);
      }}
      inputValue={text}
      onInputChange={(next) => {
        setText(next);
        if (!next) props.onChange(null);
      }}
      items={items}
      allowsEmptyCollection
      menuTrigger="input"
      aria-label="Record"
    >
      {props.label !== false && <Label>Record</Label>}
      <ComboBoxInput />
      <ComboBoxContent items={items}>
        {(item) => (
          <ComboBoxItem id={item.key} textValue={item.name}>
            {item.name}
          </ComboBoxItem>
        )}
      </ComboBoxContent>
    </ComboBox>
  );
}

/** Mount it while open, so the fields start empty. On a record, the task is on it. */
export function NewTaskDialog(props: {
  record?: { kind: CrmRecordKind; id: string };
  onClose: () => void;
}) {
  const create = useCreateTask();
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const self = useSelfMemberId();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState<string | null | undefined>(undefined);
  const [record, setRecord] = useState<PickedRecord | null>(null);
  const on = props.record ?? record;
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="New task"
      action="Create"
      disabled={!title.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            title: title.trim(),
            dueAt: dueAtOf(due),
            ...(assignee === undefined ? {} : { assigneeMemberId: assignee }),
            ...(on ? onRecord(on.kind, on.id) : {}),
          },
          {
            onSuccess: ({ task }) =>
              props.record
                ? props.onClose()
                : void navigate({
                    to: "/$workspace/crm/tasks/$id",
                    params: { workspace, id: task.id },
                  }),
            onError: (error) => crmErrorToast(error, "The task was not created"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={NAME_MAX} value={title} onChange={setTitle}>
        <Label>Title</Label>
        <Input autoComplete="off" />
      </TextField>
      <div className="grid grid-cols-2 gap-3">
        <AssigneePicker value={assignee === undefined ? self : assignee} onChange={setAssignee} />
        <TextField type="date" value={due} onChange={setDue}>
          <Label>Due</Label>
          <Input />
        </TextField>
      </div>
      {!props.record && <RecordPicker value={record} onChange={setRecord} />}
    </SettingsFormDialog>
  );
}
