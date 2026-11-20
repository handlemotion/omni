import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { IconTrash, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { Textarea } from "@/components/ui/textarea";
import { useCrmTask, useDeleteTask, useUpdateTask } from "@/hooks/use-crm-tasks.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import {
  dayOf,
  dueAtOf,
  onRecord,
  taskRecord,
  type CrmTask,
  type TaskChange,
} from "@/lib/crm-tasks.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { FieldRow, LinkValue, PlainValue } from "./record-fields.tsx";
import { RecordFrame, RecordState } from "./record-layout.tsx";
import { DAY } from "./record-list.tsx";
import { AssigneePicker, RecordPicker, useMemberNames } from "./task-dialog.tsx";

const TITLE_MAX = 500;
const BODY_MAX = 20_000;

/** One task: its title and notes, and beside them who, when and on what. */
export function TaskPage({ id }: { id: string }) {
  const query = useCrmTask(id);
  if (!query.data) return <RecordState list="tasks" query={query} />;
  return <TaskView task={query.data.task} />;
}

function TaskView({ task }: { task: CrmTask }) {
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const save = (change: TaskChange) =>
    update.mutate(
      { id: task.id, ...change },
      { onError: (error) => crmErrorToast(error, "The task was not changed") },
    );
  return (
    <RecordFrame
      list="tasks"
      name={task.title}
      actions={
        <Button
          size="sm"
          intent="outline"
          isPending={remove.isPending}
          onPress={() =>
            remove.mutate(task.id, {
              onSuccess: () =>
                void navigate({ to: "/$workspace/crm/tasks", params: { workspace } }),
              onError: (error) => crmErrorToast(error, "The task was not deleted"),
            })
          }
        >
          <IconTrash />
          Delete task
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 overflow-y-auto max-lg:flex-col lg:overflow-hidden">
        <main className="flex min-w-0 flex-1 flex-col gap-3 px-5 py-5 lg:overflow-y-auto">
          <div className="flex gap-3">
            <div className="flex h-9 items-center">
              <CheckboxField
                aria-label={task.completedAt ? "Reopen" : "Complete"}
                isSelected={!!task.completedAt}
                onChange={(done) => save({ done })}
              >
                <Checkbox />
              </CheckboxField>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <TitleField key={task.title} task={task} onSave={(title) => save({ title })} />
              <BodyField key={task.body ?? ""} task={task} onSave={(body) => save({ body })} />
            </div>
          </div>
        </main>
        <aside
          aria-label="Details"
          className="flex shrink-0 flex-col gap-0.5 px-5 py-5 lg:w-80 lg:overflow-y-auto lg:border-s"
        >
          <TaskDetails task={task} onSave={save} />
        </aside>
      </div>
    </RecordFrame>
  );
}

function TitleField(props: { task: CrmTask; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState(props.task.title);
  const commit = () => {
    const title = draft.trim();
    if (!title) return setDraft(props.task.title);
    if (title !== props.task.title) props.onSave(title);
  };
  return (
    <TextField
      aria-label="Title"
      maxLength={TITLE_MAX}
      value={draft}
      onChange={setDraft}
      className="flex-1"
    >
      <Input
        plain
        autoComplete="off"
        className="h-9 w-full rounded-md px-2 text-md hover:bg-hover focus:bg-hover"
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      />
    </TextField>
  );
}

function BodyField(props: { task: CrmTask; onSave: (body: string | null) => void }) {
  const [draft, setDraft] = useState(props.task.body ?? "");
  return (
    <Textarea
      plain
      aria-label="Notes"
      maxLength={BODY_MAX}
      rows={8}
      placeholder="Notes"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className="min-h-40 w-full resize-none rounded-md px-2 py-1.5 text-sm hover:bg-hover focus:bg-hover sm:px-2"
      onBlur={() => {
        const body = draft.trim() || null;
        if (body !== (props.task.body ?? null)) props.onSave(body);
      }}
    />
  );
}

function TaskDetails(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const { task, onSave } = props;
  const names = useMemberNames();
  const record = taskRecord(task);
  const nameOf = (id: string | null) => names.find((m) => m.id === id)?.name ?? null;
  return (
    <>
      <PlainValue label="Status">
        {task.completedAt ? `Done ${DAY.format(new Date(task.completedAt))}` : "Open"}
      </PlainValue>
      <FieldRow label="Assignee">
        <div className="w-full">
          <AssigneePicker
            inline
            value={task.assigneeMemberId}
            onChange={(assigneeMemberId) =>
              assigneeMemberId !== task.assigneeMemberId && onSave({ assigneeMemberId })
            }
          />
        </div>
      </FieldRow>
      <FieldRow label="Due">
        <TextField
          aria-label="Due"
          type="date"
          value={dayOf(task.dueAt)}
          onChange={(day) => onSave({ dueAt: dueAtOf(day) })}
          className="w-full"
        >
          <Input
            plain
            className="h-8 w-full rounded-md px-2 text-sm hover:bg-hover focus:bg-hover"
          />
        </TextField>
      </FieldRow>
      {record ? (
        <LinkValue
          label="Record"
          to={record}
          action={
            <Button
              size="sq-xs"
              intent="plain"
              aria-label="Remove from record"
              onPress={() => onSave({ companyId: null, personId: null, dealId: null })}
            >
              <IconX />
            </Button>
          }
        />
      ) : (
        <FieldRow label="Record">
          <div className="w-full">
            <RecordPicker
              label={false}
              value={null}
              onChange={(picked) => {
                if (!picked) return;
                onSave({
                  companyId: null,
                  personId: null,
                  dealId: null,
                  ...onRecord(picked.kind, picked.id),
                });
              }}
            />
          </div>
        </FieldRow>
      )}
      <PlainValue label="Created by">{nameOf(task.createdByMemberId)}</PlainValue>
      <PlainValue label="Created">{DAY.format(new Date(task.createdAt))}</PlainValue>
    </>
  );
}
