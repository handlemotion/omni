import { useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconTrash, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { useCalendarTask } from "@/hooks/use-calendar-tasks.ts";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useCrmTask } from "@/hooks/use-crm-tasks.ts";
import { ApiError } from "@/lib/api.ts";
import type { CalendarTask } from "@/lib/calendar-tasks.ts";
import type { CrmTask, TaskChange } from "@/lib/crm-tasks.ts";
import {
  asPanelTask,
  TaskContent,
  TaskDetails,
  TaskHeading,
  useDeleteCalendarThisTask,
  useDeleteThisTask,
  useSaveCalendarTask,
  useSaveTask,
} from "./task-detail.tsx";

/** The open task in the page's URL (`?task=`): its id, its link, and a way to open or close one. */
export function useOpenTask() {
  const router = useRouter();
  const { task: open } = useSearch({ strict: false }) as { task?: string };
  const at = useCallback(
    (task: string | undefined) =>
      router.buildLocation({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, task })) as never,
      }).href,
    [router],
  );
  return useMemo(
    () => ({
      id: open ?? null,
      href: (id: string) => at(id),
      close: () => void router.history.push(at(undefined)),
    }),
    [open, at, router],
  );
}

export const TASK_PANEL_WIDTH = 480;
export const TASK_PANEL_MIN = 360;
export const TASK_PANEL_MAX = 4096;
export const TASK_PANEL_KEY = "omni:task-panel-width";

const isControl = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest("input, textarea, select, [contenteditable], [role=listbox], [role=dialog]");

function useCloseOnEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isControl(event.target)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

type PanelProps = { id: string; onClose: () => void; inPlace?: boolean };

/**
 * A task beside the list, as an open email sits beside its inbox: its check and title on top, then
 * the task. `inPlace` lays it in the page instead, where a record's Tasks tab shows it over its list.
 * `from="calendar"` opens one of the member's own tasks: a private one through the calendar, one
 * on a record as the CRM shows it, where the workspace has the CRM.
 */
export function TaskPanel(props: PanelProps & { from?: "crm" | "calendar" }) {
  return props.from === "calendar" ? <CalendarTaskPanel {...props} /> : <CrmTaskPanel {...props} />;
}

function CalendarTaskPanel(props: PanelProps) {
  const query = useCalendarTask(props.id);
  const hasCrm = useHasCrm();
  const task = query.data?.task;
  useCloseOnEscape(props.onClose);
  if (task?.record && hasCrm) return <CrmTaskPanel {...props} />;
  return (
    <section aria-label="Task" className="flex min-w-0 flex-1 flex-col border-s bg-background">
      {task ? (
        <OwnTask task={task} onClose={props.onClose} canLink={hasCrm} />
      ) : (
        <Unloaded query={query} onClose={props.onClose} />
      )}
    </section>
  );
}

function OwnTask(props: { task: CalendarTask; onClose: () => void; canLink: boolean }) {
  const task = asPanelTask(props.task);
  const save = useSaveCalendarTask(task.id);
  const remove = useDeleteCalendarThisTask(task.id, props.onClose);
  return (
    <TaskBody
      task={task}
      save={save}
      remove={remove}
      onClose={props.onClose}
      details={
        <TaskDetails task={task} onSave={save} isPrivate={!task.record} canLink={props.canLink} />
      }
    />
  );
}

function Unloaded(props: {
  query: { isPending: boolean; error: unknown; refetch: () => Promise<unknown> };
  onClose: () => void;
  inPlace?: boolean;
}) {
  const { query } = props;
  return (
    <>
      <PanelHeader title={null} onClose={props.onClose} inPlace={props.inPlace} />
      {query.isPending ? (
        <Skeleton loading label="Loading task" skeleton={<PanelBones />}>
          {null}
        </Skeleton>
      ) : (
        <div className="flex flex-1 flex-col">
          {query.error instanceof ApiError && query.error.status === 404 ? (
            <EmptyState figure="loupe" title="This task is gone" />
          ) : (
            <EmptyState figure="plug" title="This task didn't load">
              <Button size="sm" intent="outline" onPress={() => void query.refetch()}>
                Try again
              </Button>
            </EmptyState>
          )}
        </div>
      )}
    </>
  );
}

function CrmTaskPanel(props: PanelProps) {
  const query = useCrmTask(props.id);
  const task = query.data?.task;
  useCloseOnEscape(props.onClose);
  return (
    <section
      aria-label="Task"
      className={`flex min-w-0 flex-1 flex-col bg-background ${props.inPlace ? "" : "border-s"}`}
    >
      {task ? (
        <LoadedTask task={task} onClose={props.onClose} inPlace={props.inPlace} />
      ) : (
        <Unloaded query={query} onClose={props.onClose} inPlace={props.inPlace} />
      )}
    </section>
  );
}

function LoadedTask(props: { task: CrmTask; onClose: () => void; inPlace?: boolean }) {
  const { task } = props;
  const save = useSaveTask(task.id);
  const remove = useDeleteThisTask(task.id, props.onClose);
  return (
    <TaskBody
      task={task}
      save={save}
      remove={remove}
      onClose={props.onClose}
      inPlace={props.inPlace}
      details={<TaskDetails task={task} onSave={save} />}
    />
  );
}

function TaskBody(props: {
  task: CrmTask;
  save: (change: TaskChange, settled?: () => void) => void;
  remove: { isPending: boolean; run: () => void };
  onClose: () => void;
  inPlace?: boolean;
  details: React.ReactNode;
}) {
  const { task, save, remove } = props;
  return (
    <>
      <PanelHeader
        title={<TaskHeading task={task} onSave={save} />}
        onClose={props.onClose}
        inPlace={props.inPlace}
      >
        <Button
          intent="plain"
          size="sq-sm"
          aria-label="Delete task"
          isPending={remove.isPending}
          onPress={remove.run}
        >
          <IconTrash />
        </Button>
      </PanelHeader>
      <div
        className={`flex min-h-0 flex-1 flex-col gap-6 ${props.inPlace ? "py-2" : "overflow-y-auto px-5 py-4"}`}
      >
        <TaskContent task={task} onSave={save} />
        <div className={`flex flex-col gap-0.5 ${props.inPlace ? "" : "-mx-5 border-t px-5 pt-4"}`}>
          {props.details}
        </div>
      </div>
    </>
  );
}

function PanelHeader(props: {
  title: React.ReactNode;
  onClose: () => void;
  inPlace?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`flex shrink-0 items-center gap-1 ${props.inPlace ? "-mt-2 -me-1.5 h-10" : "h-12 border-b ps-5 pe-2.5"}`}
    >
      <div className="flex min-w-0 flex-1 items-center">{props.title}</div>
      {props.children}
      <Button intent="plain" size="sq-sm" aria-label="Close task" onPress={props.onClose}>
        <IconX />
      </Button>
    </div>
  );
}

function PanelBones() {
  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      <SkeletonBox width="60%" height={12} />
      <SkeletonBox width="85%" height={10} />
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <SkeletonBox width={72} height={10} />
          <SkeletonBox width={`${30 + ((i * 11) % 30)}%`} height={10} />
        </div>
      ))}
    </div>
  );
}
