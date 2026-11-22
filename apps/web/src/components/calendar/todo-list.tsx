import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { crmErrorToast } from "@/components/crm/crm-errors.ts";
import { IconCheck, IconEye, IconPlus, IconRestore } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { contextMenuProps } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Link } from "@/components/ui/link";
import { TextField } from "@/components/ui/text-field";
import {
  useCalendarTasks,
  useCreateCalendarTask,
  useUpdateCalendarTask,
} from "@/hooks/use-calendar-tasks.ts";
import { useOpenTask } from "@/components/tasks/task-panel.tsx";
import { endDrag, startDrag, timedTodo } from "@/lib/calendar-drag.ts";
import { stableId } from "@/lib/crm-pending.ts";
import type { Todo } from "@/lib/calendar-tasks.ts";
import { dayOf, dueAtOf, dueGroup, dueLabel, type DueGroup } from "@/lib/crm-tasks.ts";

const SECTIONS: { id: DueGroup; label: string; fixed: boolean }[] = [
  { id: "overdue", label: "Overdue", fixed: false },
  { id: "today", label: "Today", fixed: true },
  { id: "upcoming", label: "Upcoming", fixed: true },
  { id: "none", label: "No date", fixed: true },
];

const opened = Date.now();

const doneSinceOpened = (task: Todo) =>
  !!task.completedAt && Date.parse(task.completedAt) >= opened;

/**
 * Every open to-do the member owns or is assigned, all pages loaded, and the ones they checked
 * off since the page opened, still in place and marked done. Both lists are the server's, so a
 * to-do reopened, renamed or deleted elsewhere shows as it is now.
 */
export function useMyTodos() {
  const open = useCalendarTasks("open");
  const done = useCalendarTasks("done");
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = open;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const openTasks = open.tasks;
  const finished = done.tasks;
  return useMemo(() => {
    const openIds = new Set(openTasks.map((task) => task.id));
    const recent = finished.filter((task) => doneSinceOpened(task) && !openIds.has(task.id));
    return [...openTasks, ...recent];
  }, [openTasks, finished]);
}

/** Checks a to-do off, or opens it again. */
export function useToggleTodo() {
  const update = useUpdateCalendarTask();
  return (task: Todo, done: boolean) =>
    update.mutate(
      { id: task.id, done, linked: !!task.record },
      { onError: (error) => crmErrorToast(error, "The to-do was not changed") },
    );
}

function dueFor(section: DueGroup) {
  if (section === "none" || section === "overdue") return null;
  const now = new Date();
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (section === "today" ? 0 : 1),
    12,
  );
  return dueAtOf(dayOf(day.toISOString()));
}

/** The to-dos beside the calendar, in fixed sections by when they're due. */
export function TodoList() {
  const tasks = useMyTodos();
  const [adding, setAdding] = useState<DueGroup | null>(null);
  const now = new Date();
  return (
    <div className="flex flex-col">
      {SECTIONS.map((section) => {
        const inSection = tasks.filter((task) => dueGroup(task, now) === section.id);
        if (!section.fixed && inSection.length === 0) return null;
        return (
          <section key={section.id} aria-label={section.label} className="flex flex-col pb-3">
            <div className="group/section flex h-7 items-center gap-1.5 ps-2 pe-1">
              <span className="text-label text-subtle-foreground">{section.label}</span>
              {inSection.length > 0 && (
                <span className="text-label text-subtle-foreground tabular-nums">
                  {inSection.length}
                </span>
              )}
              {section.fixed && (
                <Button
                  size="sq-xs"
                  intent="plain"
                  aria-label={`New to-do in ${section.label}`}
                  className="ms-auto opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  onPress={() => setAdding(section.id)}
                >
                  <IconPlus />
                </Button>
              )}
            </div>
            {inSection.map((task) => (
              <TodoRow key={stableId(task.id)} task={task} overdue={section.id === "overdue"} />
            ))}
            {adding === section.id && (
              <NewTodo section={section.id} onDone={() => setAdding(null)} />
            )}
          </section>
        );
      })}
    </div>
  );
}

const ROW = "flex h-8 min-w-0 items-center gap-2 rounded-md ps-1.5 pe-1";
const ROUND =
  "w-4.25 shrink-0 gap-x-0 overflow-hidden **:data-[slot=control-label]:hidden **:data-[slot=indicator]:rounded-full";

function NewTodo({ section, onDone }: { section: DueGroup; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const create = useCreateCalendarTask();
  const save = () => {
    const trimmed = title.trim();
    if (!trimmed) return onDone();
    setTitle("");
    create.create({ title: trimmed, dueAt: dueFor(section) }, (error) =>
      crmErrorToast(error, "The to-do was not added"),
    );
  };
  return (
    <div className={ROW}>
      <CheckboxField aria-hidden excludeFromTabOrder className={`${ROUND} pointer-events-none`}>
        <Checkbox />
      </CheckboxField>
      <TextField aria-label="New to-do" maxLength={500} value={title} onChange={setTitle}>
        <Input
          plain
          autoFocus
          autoComplete="off"
          className="h-8 px-0 text-sm"
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            if (event.key === "Escape") onDone();
          }}
          onBlur={() => !title.trim() && onDone()}
        />
      </TextField>
    </div>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function dueText(task: Todo) {
  const day = dueLabel(task.dueAt);
  if (!task.dueAt || !timedTodo(task)) return day;
  const at = clock.format(new Date(task.dueAt));
  return day === "Today" ? at : `${day} ${at}`;
}

function TodoRow({ task, overdue }: { task: Todo; overdue: boolean }) {
  const toggle = useToggleTodo();
  const open = useOpenTask();
  const done = !!task.completedAt;
  const navigate = useNavigate();
  const menu = contextMenuProps(() => [
    {
      icon: IconEye,
      label: "Open",
      onAction: () => void navigate({ href: open.href(task.id) }),
    },
    {
      icon: done ? IconRestore : IconCheck,
      label: done ? "Reopen" : "Complete",
      onAction: () => toggle(task, !done),
    },
  ]);
  return (
    <div
      data-todo={task.id}
      data-calendar-keys="off"
      draggable
      onDragStart={(event) => startDrag(event, { kind: "todo", task })}
      onDragEnd={endDrag}
      className={`${ROW} hover:bg-hover ${open.id === task.id ? "bg-accent" : ""}`}
      {...menu}
    >
      <CheckboxField
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        isSelected={done}
        onChange={(next: boolean) => toggle(task, next)}
        className={ROUND}
      >
        <Checkbox />
      </CheckboxField>
      <Link
        href={open.href(task.id)}
        className={`min-w-0 flex-1 truncate text-sm ${done ? "text-muted-foreground line-through" : "text-foreground"}`}
      >
        {task.title}
      </Link>
      {task.dueAt && (
        <span
          className={`shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs tabular-nums ${overdue ? "text-danger" : "text-muted-foreground"}`}
        >
          {dueText(task)}
        </span>
      )}
    </div>
  );
}
