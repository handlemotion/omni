import { useState } from "react";
import { IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDeleteCalendarTask } from "@/hooks/use-calendar-tasks.ts";
import { useDeleteTask, useUpdateTask } from "@/hooks/use-crm-tasks.ts";
import { useMember } from "@/hooks/use-session.ts";
import { updateCalendarTaskMutation, type CalendarTask } from "@/lib/calendar-tasks.ts";
import { CRM_WRITE } from "@/lib/crm-cache.ts";
import { stableId } from "@/lib/crm-pending.ts";
import {
  dayOf,
  dueAtOf,
  onRecord,
  taskKeys,
  taskRecord,
  updateTaskMutation,
  type CrmTask,
  type TaskChange,
} from "@/lib/crm-tasks.ts";
import { crmErrorToast } from "@/components/crm/crm-errors.ts";
import { DayValue, FieldRow, LinkValue, PlainValue } from "@/components/crm/record-fields.tsx";
import { DAY } from "@/components/crm/record-list.tsx";
import { AssigneePicker, RecordPicker, useMemberNames } from "@/components/crm/task-dialog.tsx";
import { CHECK_CELL, Subtasks } from "@/components/crm/task-subtasks.tsx";
import { TaskMeeting } from "@/components/meetings/event-recording.tsx";

const TITLE_MAX = 500;
const BODY_MAX = 20_000;

/**
 * Saves a change to the task, with a toast when it fails, then `settled`. Saves run one at a time
 * per task, so a checklist sent whole never lands over a newer one sent after it, and the task is
 * fetched again only after the last queued save.
 */
export function useSaveTask(id: string) {
  const client = useQueryClient();
  const base = updateTaskMutation(client, useMember().member.id);
  const queue = stableId(id);
  const mutationKey = [...CRM_WRITE, "task-save", queue];
  const update = useMutation({
    ...base,
    mutationKey,
    scope: { id: `crm-task:${queue}` },
    onSettled: (...args) => {
      if (client.isMutating({ mutationKey }) > 1) return;
      if (args[0]) client.setQueryData(taskKeys.one(args[0].task.id), args[0]);
      return base.onSettled?.(...args);
    },
  });
  return (change: TaskChange, settled?: () => void) =>
    void update
      .mutateAsync({ id, ...change })
      .catch((error: unknown) => crmErrorToast(error, "The task was not changed"))
      .finally(settled);
}

/** A task the calendar holds, as the panel's fields read it: a private one is on no record. */
export const asPanelTask = (task: CalendarTask) =>
  ({
    ...task,
    companyId: task.record?.kind === "company" ? task.record.id : null,
    personId: task.record?.kind === "person" ? task.record.id : null,
    dealId: task.record?.kind === "deal" ? task.record.id : null,
    recordName: null,
    recordDomain: null,
  }) satisfies CrmTask;

/**
 * `useSaveTask` for a task the member owns in the calendar: its own fields save through the
 * calendar, one save at a time; picking a record puts it on the CRM through the CRM's route.
 */
export function useSaveCalendarTask(id: string) {
  const client = useQueryClient();
  const base = updateCalendarTaskMutation(client, useMember().member.id);
  const queue = stableId(id);
  const update = useMutation({ ...base, scope: { id: `calendar-task:${queue}` } });
  const link = useUpdateTask();
  return (change: TaskChange, settled?: () => void) => {
    const { companyId, personId, dealId, assigneeMemberId: _assignee, ...own } = change;
    const record = companyId ?? personId ?? dealId;
    const saved = record
      ? link.mutateAsync({ id, companyId, personId, dealId })
      : update.mutateAsync({ id, ...own });
    void saved
      .catch((error: unknown) => crmErrorToast(error, "The task was not changed"))
      .finally(settled);
  };
}

/** Deletes the calendar's task, then `onDeleted`. */
export function useDeleteCalendarThisTask(id: string, onDeleted: () => void) {
  const remove = useDeleteCalendarTask();
  return {
    isPending: remove.isPending,
    run: () =>
      remove.mutate(id, {
        onSuccess: onDeleted,
        onError: (error) => crmErrorToast(error, "The task was not deleted"),
      }),
  };
}

/** Deletes the task, then `onDeleted` (back to the list). */
export function useDeleteThisTask(id: string, onDeleted: () => void) {
  const remove = useDeleteTask();
  return {
    isPending: remove.isPending,
    run: () =>
      remove.mutate(id, {
        onSuccess: onDeleted,
        onError: (error) => crmErrorToast(error, "The task was not deleted"),
      }),
  };
}

/** The task's check, then its title, which saves when it loses focus. */
export function TaskHeading(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const { task, onSave } = props;
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <div className={CHECK_CELL}>
        <CheckboxField
          aria-label={task.completedAt ? "Reopen" : "Complete"}
          isSelected={!!task.completedAt}
          onChange={(done) => onSave({ done })}
        >
          <Checkbox />
        </CheckboxField>
      </div>
      <TitleField key={stableId(task.id)} task={task} onSave={(title) => onSave({ title })} />
    </div>
  );
}

/** Under the heading, as an issue reads: the description, then the subtasks. */
export function TaskContent(props: {
  task: CrmTask;
  onSave: (change: TaskChange, settled?: () => void) => void;
}) {
  const { task, onSave } = props;
  return (
    <div className="flex flex-col gap-5">
      <BodyField key={stableId(task.id)} task={task} onSave={(body) => onSave({ body })} />
      <Subtasks task={task} onSave={onSave} />
    </div>
  );
}

function useDraft(saved: string) {
  const [draft, setDraft] = useState(saved);
  const [seen, setSeen] = useState(saved);
  const [editing, setEditing] = useState(false);
  if (saved !== seen && !editing) {
    setSeen(saved);
    setDraft(saved);
  }
  return {
    draft,
    setDraft,
    onFocus: () => setEditing(true),
    done: () => {
      setEditing(false);
      setSeen(saved);
    },
  };
}

function TitleField(props: { task: CrmTask; onSave: (title: string) => void }) {
  const { draft, setDraft, onFocus, done } = useDraft(props.task.title);
  const commit = () => {
    done();
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
      className="min-w-0 flex-1"
    >
      <Input
        plain
        autoComplete="off"
        className="h-9 w-full rounded-md px-1.5 text-md hover:bg-hover focus:bg-hover"
        onFocus={onFocus}
        onBlur={commit}
        onKeyDown={(event) =>
          event.key === "Enter" && !event.nativeEvent.isComposing && event.currentTarget.blur()
        }
      />
    </TextField>
  );
}

function BodyField(props: { task: CrmTask; onSave: (body: string | null) => void }) {
  const { draft, setDraft, onFocus, done } = useDraft(props.task.body ?? "");
  return (
    <Textarea
      plain
      aria-label="Description"
      maxLength={BODY_MAX}
      placeholder="Add description"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className="-mx-1.5 field-sizing-content min-h-8 w-[calc(100%+--spacing(3))] resize-none rounded-md px-1.5 py-1.5 text-sm placeholder:text-muted-foreground hover:bg-hover focus:bg-hover sm:px-1.5"
      onFocus={onFocus}
      onBlur={() => {
        done();
        const body = draft.trim() || null;
        if (body !== (props.task.body ?? null)) props.onSave(body);
      }}
    />
  );
}

/**
 * When, on what and who: the task's fields, one per row. A private task has no assignee; where
 * the workspace has the CRM it can be added to a record.
 */
export function TaskDetails(props: {
  task: CrmTask;
  onSave: (change: TaskChange) => void;
  isPrivate?: boolean;
  canLink?: boolean;
}) {
  const { task, onSave } = props;
  const names = useMemberNames();
  const record = taskRecord(task);
  const nameOf = (id: string | null) => names.find((m) => m.id === id)?.name ?? null;
  return (
    <>
      <PlainValue label="Status">
        {task.completedAt ? `Done ${DAY.format(new Date(task.completedAt))}` : "Open"}
      </PlainValue>
      <DayValue
        label="Due"
        value={dayOf(task.dueAt) || null}
        onSave={(day) => onSave({ dueAt: dueAtOf(day ?? "") })}
      />
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
      ) : props.isPrivate && !props.canLink ? null : (
        <FieldRow label={props.isPrivate ? "Add to CRM" : "Record"}>
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
      {!props.isPrivate && (
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
      )}
      <TaskMeeting taskId={task.id} />
      <PlainValue label="Created by">{nameOf(task.createdByMemberId)}</PlainValue>
      <PlainValue label="Created">{DAY.format(new Date(task.createdAt))}</PlainValue>
    </>
  );
}
