import type { CrmTask } from "@omni/client";
import { useState } from "react";
import { IconDescription } from "@/components/icons/central";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDeleteCalendarTask } from "@/hooks/use-calendar-tasks.ts";
import { useDeleteTask, useUpdateTask } from "@/hooks/use-crm-tasks.ts";
import { useMember } from "@/hooks/use-session.ts";
import { updateCalendarTaskMutation, type CalendarTask } from "@/lib/calendar-tasks.ts";
import { lastWrite } from "@/lib/cache.ts";
import { CRM_WRITE } from "@/lib/crm-cache.ts";
import { stableId } from "@/lib/crm-pending.ts";
import { taskRecord, updateTaskMutation, type TaskChange } from "@/lib/crm-tasks.ts";
import { keys } from "@/lib/query-keys.ts";
import { crmErrorToast } from "@/components/crm/crm-errors.ts";
import { Subtasks } from "@/components/crm/task-subtasks.tsx";
import { TaskMeeting } from "@/components/meetings/event-recording.tsx";
import type { TaskSource } from "@/lib/task-activity.ts";
import { TaskActivity } from "./task-activity.tsx";
import {
  AssigneeField,
  DueField,
  PriorityField,
  RecordField,
  StatusField,
} from "./task-fields.tsx";

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
      if (!lastWrite(client, mutationKey)) return;
      if (args[0]) client.setQueryData(keys.crmTask(args[0].task.id), args[0]);
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

/** The task's title, which saves when it loses focus. */
export function TaskHeading(props: { task: CrmTask; onSave: (change: TaskChange) => void }) {
  const { task, onSave } = props;
  return <TitleField key={stableId(task.id)} task={task} onSave={(title) => onSave({ title })} />;
}

/** Under the title, as an issue reads: the description. */
export function TaskDescription(props: {
  task: CrmTask;
  onSave: (change: TaskChange, settled?: () => void) => void;
}) {
  const { task, onSave } = props;
  return (
    <section aria-label="Description" className="flex flex-col gap-1">
      <h3 className="flex h-6 items-center gap-1.5 text-sm text-muted-foreground">
        <IconDescription aria-hidden className="size-3.5" />
        Description
      </h3>
      <BodyField key={stableId(task.id)} task={task} onSave={(body) => onSave({ body })} />
    </section>
  );
}

/** After the details: the subtasks, then what happened to the task. */
export function TaskFollowUp(props: {
  task: CrmTask;
  source: TaskSource;
  onSave: (change: TaskChange, settled?: () => void) => void;
}) {
  return (
    <>
      <Subtasks task={props.task} onSave={props.onSave} />
      <TaskActivity task={props.task} source={props.source} />
    </>
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
      className="-mx-1.5 min-w-0"
    >
      <Input
        plain
        autoComplete="off"
        className="h-9 w-full rounded-md px-1.5 text-lg font-medium hover:bg-hover focus:bg-hover"
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
 * Where it stands, who has it, when and on what: the task's fields, one per row. A private task
 * has no assignee; where the workspace has the CRM it can be added to a record.
 */
export function TaskDetails(props: {
  task: CrmTask;
  onSave: (change: TaskChange) => void;
  isPrivate?: boolean;
  canLink?: boolean;
}) {
  const { task, onSave } = props;
  const linkable = !!taskRecord(task) || !props.isPrivate || props.canLink;
  return (
    <section aria-label="Details" className="flex flex-col gap-0.5">
      <StatusField task={task} onSave={onSave} />
      {!props.isPrivate && <AssigneeField task={task} onSave={onSave} />}
      <DueField task={task} onSave={onSave} />
      <PriorityField task={task} onSave={onSave} />
      {linkable && <RecordField task={task} onSave={onSave} isPrivate={props.isPrivate} />}
      <TaskMeeting taskId={task.id} />
    </section>
  );
}
