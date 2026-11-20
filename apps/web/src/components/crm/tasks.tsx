import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CreateMenu } from "./create-menu.tsx";
import { createContext, use, useEffect, useMemo, useRef, useState } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconPlus } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Heading } from "@/components/ui/heading";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { Link } from "@/components/ui/link";
import { useCrmTasks, useUpdateTask } from "@/hooks/use-crm-tasks.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import type { CrmRecordKind } from "@/lib/crm.ts";
import {
  DUE_GROUPS,
  dueGroup,
  dueLabel,
  dueOnDrop,
  recordFilter,
  taskRecord,
  type CrmTask,
  type DueGroup,
  type TaskFilter,
} from "@/lib/crm-tasks.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { RecordMark } from "./record-list.tsx";
import type { FilterKind } from "./list-filters.tsx";
import { ListFilter } from "./list-toolbar.tsx";
import { MemberAvatar } from "./member-avatar.tsx";
import { NewTaskDialog, useMemberNames } from "./task-dialog.tsx";
import { TaskPanel, useOpenTask } from "./task-panel.tsx";
import { TaskRail } from "./task-rail.tsx";

/** Every task in the workspace: mine, everyone's (by assignee and due), or done. */
export function TasksPage(props: {
  /** A member id, `none` or `anyone`; left out, the person's own. */
  assignee?: string | undefined;
  status?: "done" | undefined;
  q: string;
  /** The task open in the panel beside the list. */
  task?: string;
}) {
  const phone = useIsMobile();
  const open = useOpenTask();
  const panel = useStoredWidth("omni:task-panel-width", PANEL_WIDTH, PANEL_MIN, PANEL_MAX);
  const rowRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const { close } = open;
  useEffect(() => {
    if (!props.task) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isControl(event.target)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.task, close]);
  const opened = useMemo(
    () => ({ id: props.task ?? null, href: open.href }),
    [props.task, open.href],
  );
  const [adding, setAdding] = useState(false);
  const filter: TaskFilter = {
    status: props.status ?? "open",
    assignee: props.assignee === "anyone" ? undefined : (props.assignee ?? "me"),
    q: props.q,
  };
  const list = (
    <StorageFrame
      title={
        <div className="flex min-w-0 items-center gap-3">
          <Heading className="truncate text-md">Tasks</Heading>
        </div>
      }
      actions={
        <>
          <ListFilter
            search={{ assignee: props.assignee, status: props.status }}
            filters={TASK_FILTERS}
          />
          <CreateMenu />
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        <TaskList
          filter={filter}
          grouped={props.status !== "done"}
          showRecord
          searched={!!props.q}
        />
      </div>
      {adding && <NewTaskDialog onClose={() => setAdding(false)} />}
    </StorageFrame>
  );
  if (!props.task) return <OpenTaskContext value={opened}>{list}</OpenTaskContext>;
  return (
    <OpenTaskContext value={opened}>
      <div
        ref={rowRef}
        className={`flex h-svh min-h-0 min-w-0 flex-1 ${resizing ? "cursor-ew-resize select-none" : ""}`}
      >
        <div ref={listRef} className={`flex min-w-80 flex-1 flex-col ${phone ? "hidden" : ""}`}>
          {list}
        </div>
        <div
          style={phone ? undefined : { width: panel.width }}
          className={`relative flex min-w-0 ${phone ? "flex-1" : "shrink"}`}
        >
          {!phone && (
            <ResizeGrip
              label="Resize tasks"
              width={() => listRef.current?.offsetWidth ?? 0}
              onResize={(width) =>
                panel.set((rowRef.current?.offsetWidth ?? 0) - Math.max(LIST_MIN, width))
              }
              onReset={panel.reset}
              onResizingChange={setResizing}
            />
          )}
          <TaskPanel key={props.task} id={props.task} onClose={open.close} />
        </div>
      </div>
    </OpenTaskContext>
  );
}

const TASK_FILTERS: FilterKind[] = ["assignee", "status"];

const PANEL_WIDTH = 480;
const PANEL_MIN = 360;
const PANEL_MAX = 4096;
const LIST_MIN = 320;

const isControl = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest("input, textarea, select, [contenteditable], [role=listbox], [role=dialog]");

const OpenTaskContext = createContext<{
  id: string | null;
  href: (id: string) => string;
} | null>(null);

/** A record's own tasks, open first then done, with a way to add one. */
export function RecordTasks(props: { kind: CrmRecordKind; id: string }) {
  const [adding, setAdding] = useState(false);
  const filter = recordFilter(props.kind, props.id);
  return (
    <div className="flex flex-col gap-6 lg:min-h-[calc(100dvh-8rem)]">
      <TaskRail filter={filter} />
      <div className="sticky bottom-0 mt-auto flex min-h-8 justify-end bg-background pt-3">
        <Button size="sm" onPress={() => setAdding(true)}>
          <IconPlus />
          New task
        </Button>
      </div>
      {adding && (
        <NewTaskDialog
          record={{ kind: props.kind, id: props.id }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function TaskList(props: {
  filter: TaskFilter;
  grouped: boolean;
  showRecord: boolean;
  searched?: boolean;
}) {
  const list = useCrmTasks(props.filter);
  if (list.isPending) {
    return (
      <Skeleton loading label="Loading tasks" skeleton={<TaskBones />}>
        {null}
      </Skeleton>
    );
  }
  if (list.isError) return <ListFailed retry={() => void list.refetch()} />;
  if (!list.tasks.length) {
    if (!props.grouped && !props.showRecord) return null;
    return props.searched ? (
      <EmptyState figure="loupe" title="Nothing matches" />
    ) : (
      <EmptyState
        figure="cabinet"
        title={props.filter.status === "done" ? "No done tasks" : "No tasks"}
      />
    );
  }
  const more = list.hasNextPage && (
    <Button
      size="sm"
      intent="plain"
      className="self-start"
      isPending={list.isFetchingNextPage}
      onPress={() => void list.fetchNextPage()}
    >
      Show more
    </Button>
  );
  if (!props.grouped) {
    return (
      <div className="flex flex-col gap-1">
        <TaskRows tasks={list.tasks} showRecord={props.showRecord} />
        {more}
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <DueSections tasks={list.tasks} showRecord={props.showRecord} />
      {more}
    </div>
  );
}

function DueSections(props: { tasks: CrmTask[]; showRecord: boolean }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const update = useUpdateTask();
  const [lifted, setLifted] = useState<CrmTask | null>(null);
  const now = new Date();
  const drop = (event: DragEndEvent) => {
    setLifted(null);
    const task = props.tasks.find((each) => each.id === event.active.id);
    const group = DUE_GROUPS.find(({ id }) => id === event.over?.id);
    if (!task || !group) return;
    const dueAt = dueOnDrop(task, group.id, now);
    if (dueAt === undefined) return;
    update.mutate(
      { id: task.id, dueAt },
      { onError: (error) => crmErrorToast(error, "The task was not rescheduled") },
    );
  };
  const shown = DUE_GROUPS.filter(
    ({ id }) =>
      props.tasks.some((task) => dueGroup(task, now) === id) || (lifted && id !== "overdue"),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(event: DragStartEvent) =>
        setLifted(props.tasks.find((task) => task.id === event.active.id) ?? null)
      }
      onDragEnd={drop}
      onDragCancel={() => setLifted(null)}
    >
      {shown.map(({ id, label }, index) => (
        <DueSection
          key={id}
          group={id}
          label={label}
          first={index === 0}
          tasks={props.tasks.filter((task) => dueGroup(task, now) === id)}
          lifted={lifted}
          showRecord={props.showRecord}
        />
      ))}
      <DragOverlay dropAnimation={null}>
        {lifted && (
          <ul className="cursor-grabbing rounded-lg border bg-background">
            <TaskRow task={lifted} showRecord={props.showRecord} />
          </ul>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function DueSection(props: {
  group: DueGroup;
  label: string;
  first: boolean;
  tasks: CrmTask[];
  lifted: CrmTask | null;
  showRecord: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: props.group,
    disabled: props.group === "overdue",
  });
  const taking = isOver && !!props.lifted && dueOnDrop(props.lifted, props.group) !== undefined;
  return (
    <section
      ref={setNodeRef}
      aria-label={props.label}
      data-taking={taking || undefined}
      className="flex flex-col rounded-lg transition-colors duration-150 ease-out data-taking:bg-hover"
    >
      <h3
        className={`flex items-end gap-1.5 px-2 pb-2 text-xs text-muted-foreground ${props.first ? "h-9" : "h-12"}`}
      >
        {props.label}
        <span className="text-subtle-foreground tabular-nums">{props.tasks.length}</span>
      </h3>
      <ul className="flex min-h-12 flex-col">
        {props.tasks.map((task) => (
          <DraggableTask key={task.id} task={task} showRecord={props.showRecord} />
        ))}
      </ul>
    </section>
  );
}

function DraggableTask(props: { task: CrmTask; showRecord: boolean }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: props.task.id });
  return (
    <TaskRow
      task={props.task}
      showRecord={props.showRecord}
      lift={{
        ref: setNodeRef,
        onPointerDownCapture: listeners?.onPointerDown as React.PointerEventHandler | undefined,
        hidden: isDragging,
      }}
    />
  );
}

function TaskRows(props: { tasks: CrmTask[]; showRecord: boolean }) {
  return (
    <ul className="flex flex-col">
      {props.tasks.map((task) => (
        <TaskRow key={task.id} task={task} showRecord={props.showRecord} />
      ))}
    </ul>
  );
}

/** One task: its check, title, record, due day and assignee. */
export function TaskRow(props: {
  task: CrmTask;
  showRecord: boolean;
  lift?: {
    ref: (element: HTMLElement | null) => void;
    onPointerDownCapture: React.PointerEventHandler | undefined;
    hidden: boolean;
  };
}) {
  const { task } = props;
  const { href: inWorkspace } = useWorkspacePaths();
  const opened = use(OpenTaskContext);
  const update = useUpdateTask();
  const names = useMemberNames();
  const assignee = names.find((member) => member.id === task.assigneeMemberId);
  const record = props.showRecord ? taskRecord(task) : null;
  const done = !!task.completedAt;
  const overdue = !done && !!task.dueAt && new Date(task.dueAt) < new Date();
  const toggle = (next: boolean) =>
    update.mutate(
      { id: task.id, done: next },
      { onError: (error) => crmErrorToast(error, "The task was not changed") },
    );
  return (
    <li
      ref={props.lift?.ref}
      onPointerDownCapture={props.lift?.onPointerDownCapture}
      className={`group flex h-12 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors duration-150 ease-out ${opened?.id === task.id ? "bg-accent" : "hover:bg-hover"} ${props.lift?.hidden ? "opacity-0" : ""}`}
    >
      <CheckboxField
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        isSelected={done}
        onChange={toggle}
      >
        <Checkbox />
      </CheckboxField>
      <Link
        href={
          opened ? opened.href(task.id) : inWorkspace(`/crm/tasks/${encodeURIComponent(task.id)}`)
        }
        className={`min-w-0 flex-1 truncate text-sm ${done ? "text-muted-foreground" : "text-foreground"}`}
      >
        {task.title}
      </Link>
      {record && (
        <Link
          href={inWorkspace(`/crm/${record.kind}/${encodeURIComponent(record.id)}`)}
          className="flex max-w-48 min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground hover:text-foreground max-sm:hidden"
        >
          <RecordMark
            name={record.name}
            square={record.kind === "companies"}
            who={"domain" in record && record.domain ? { domain: record.domain } : null}
            size={16}
          />
          <span className="truncate">{record.name}</span>
        </Link>
      )}
      <span
        className={`w-20 shrink-0 text-end text-xs tabular-nums ${overdue ? "text-danger" : "text-muted-foreground"}`}
      >
        {dueLabel(done ? task.completedAt : task.dueAt)}
      </span>
      <span className="flex w-5 shrink-0 justify-center" title={assignee?.name}>
        {assignee && <MemberAvatar name={assignee.name} image={assignee.image} size={20} />}
      </span>
    </li>
  );
}

function TaskBones() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex h-12 items-center gap-3 px-2">
          <SkeletonBox width={16} height={16} radius="4px" />
          <span className="min-w-0 flex-1">
            <SkeletonBox width={`${30 + ((i * 17) % 40)}%`} height={10} />
          </span>
          <SkeletonBox width={48} height={10} />
          <SkeletonBox width={20} height={20} radius="999px" />
        </div>
      ))}
    </div>
  );
}
