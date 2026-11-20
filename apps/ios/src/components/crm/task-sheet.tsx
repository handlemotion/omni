import { router } from "expo-router";
import { useState } from "react";
import { Segmented } from "@/components/ui/segmented.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import type { CrmRecordKind } from "@/lib/crm-mutations.ts";
import { DUE_CHOICES, dueIn, onRecord, useCreateTask } from "@/lib/crm-tasks.ts";
import { SheetForm } from "./sheet-form.tsx";

const TITLE_MAX = 500;
type Due = "none" | (typeof DUE_CHOICES)[number]["label"];

/**
 * A new task, yours until you give it to someone. On a record, the task is on it and the sheet
 * closes back to it; otherwise the new task's screen opens.
 */
export function TaskSheet(props: { record?: { kind: CrmRecordKind; id: string } }) {
  const create = useCreateTask();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<Due>("none");
  const days = DUE_CHOICES.find((choice) => choice.label === due)?.days;
  return (
    <SheetForm
      title="New task"
      action="Create"
      disabled={!title.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            title: title.trim(),
            dueAt: days === undefined ? null : dueIn(days),
            ...(props.record ? onRecord(props.record.kind, props.record.id) : {}),
          },
          {
            onSuccess: ({ task }) => {
              router.back();
              if (!props.record) {
                router.push({ pathname: "/crm/task/[id]", params: { id: task.id } });
              }
            },
            onError: (error) => crmErrorAlert(error, "The task was not created"),
          },
        )
      }
    >
      <TextField
        label="Title"
        placeholder="Title"
        autoFocus
        maxLength={TITLE_MAX}
        returnKeyType="done"
        value={title}
        onChangeText={setTitle}
      />
      <Segmented<Due>
        value={due}
        onChange={setDue}
        options={[
          { id: "none", label: "No date" },
          ...DUE_CHOICES.map((choice) => ({ id: choice.label, label: choice.label })),
        ]}
      />
    </SheetForm>
  );
}
