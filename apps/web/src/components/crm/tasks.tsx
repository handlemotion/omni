import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconPlus } from "@/components/icons/central";
import { ListFailed } from "@/components/inbox/thread-list";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Heading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCrmTaskCounts, useCrmTasks, useUpdateTask } from "@/hooks/use-crm-tasks.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import type { CrmRecordKind } from "@/lib/crm.ts";
import {
  DUE_GROUPS,
  dueGroup,
  dueLabel,
  recordFilter,
  taskRecord,
  type CrmTask,
  type TaskFilter,
} from "@/lib/crm-tasks.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { useListSearch } from "./record-list.tsx";
import { RecordMark } from "./record-list.tsx";
import { NewTaskDialog, useMemberNames } from "./task-dialog.tsx";

export type TasksView = "mine" | "all" | "done";

const VIEWS: { id: TasksView; label: string }[] = [
  { id: "mine", label: "My tasks" },
  { id: "all", label: "All" },
  { id: "done", label: "Done" },
];

/** Every task in the workspace: mine, everyone's (by assignee and due), or done. */
export function TasksPage(props: { view: TasksView; assignee?: string; q: string }) {
  const phone = useIsMobile();
  const search = useListSearch(props.q);
  const [adding, setAdding] = useState(false);
  const filter: TaskFilter = {
    status: props.view === "done" ? "done" : "open",
    assignee: props.view === "mine" ? "me" : props.assignee,
    q: props.q,
  };
  return (
    <StorageFrame
      title={<Heading className="truncate text-md">Tasks</Heading>}
      actions={
        <>
          <SearchField
            aria-label="Search tasks"
            value={search.text}
            onChange={search.setText}
            className="w-40 sm:w-56"
          >
            <SearchInput size="sm" />
          </SearchField>
          <Button
            size={phone ? "sq-sm" : "sm"}
            aria-label={phone ? "New task" : undefined}
            onPress={() => setAdding(true)}
          >
            <IconPlus />
            {!phone && "New task"}
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-2 px-5 pb-2">
        <ViewTabs view={props.view} />
        {props.view !== "mine" && <AssigneeFilter value={props.assignee} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        <TaskList filter={filter} grouped={props.view !== "done"} showRecord searched={!!props.q} />
      </div>
      {adding && <NewTaskDialog onClose={() => setAdding(false)} />}
    </StorageFrame>
  );
}

function ViewTabs({ view }: { view: TasksView }) {
  const navigate = useNavigate();
  const counts = useCrmTaskCounts().data;
  const count = (id: TasksView) =>
    id === "mine" ? counts?.mine : id === "all" ? counts?.open : undefined;
  return (
    <ToggleGroup
      size="xs"
      aria-label="Tasks"
      selectedKeys={[view]}
      disallowEmptySelection
      onSelectionChange={(keys) => {
        const next = [...keys][0] as TasksView | undefined;
        if (!next) return;
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({
            ...prev,
            view: next === "mine" ? undefined : next,
          }),
          replace: true,
        });
      }}
    >
      {VIEWS.map(({ id, label }) => (
        <ToggleGroupItem key={id} id={id}>
          {label}
          {count(id) ? (
            <span className="text-muted-foreground tabular-nums">{count(id)}</span>
          ) : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const ANYONE = "anyone";

function AssigneeFilter({ value }: { value: string | undefined }) {
  const navigate = useNavigate();
  const people = [
    { id: ANYONE, name: "Anyone" },
    ...useMemberNames(),
    { id: "none", name: "Unassigned" },
  ];
  return (
    <Select
      aria-label="Assignee"
      value={value ?? ANYONE}
      onChange={(id) =>
        void navigate({
          to: ".",
          search: (prev: Record<string, unknown>) => ({
            ...prev,
            assignee: !id || id === ANYONE ? undefined : String(id),
          }),
          replace: true,
        })
      }
      className="w-44"
    >
      <SelectTrigger className="h-7" />
      <SelectContent items={people}>
        {(person) => (
          <SelectItem id={person.id} textValue={person.name}>
            {person.name}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/** A record's own tasks, open first then done, with a way to add one. */
export function RecordTasks(props: { kind: CrmRecordKind; id: string }) {
  const [adding, setAdding] = useState(false);
  const filter = recordFilter(props.kind, props.id);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" onPress={() => setAdding(true)}>
          <IconPlus />
          New task
        </Button>
      </div>
      <TaskList filter={{ ...filter, status: "open" }} grouped={false} showRecord={false} />
      <DoneTasks filter={filter} />
      {adding && (
        <NewTaskDialog
          record={{ kind: props.kind, id: props.id }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function DoneTasks({ filter }: { filter: TaskFilter }) {
  const list = useCrmTasks({ ...filter, status: "done" });
  if (!list.tasks.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-sm text-muted-foreground">Done</h3>
      <TaskRows tasks={list.tasks} showRecord={false} />
    </section>
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
  const now = new Date();
  return (
    <div className="flex flex-col gap-4">
      {DUE_GROUPS.map(({ id, label }) => {
        const tasks = list.tasks.filter((task) => dueGroup(task, now) === id);
        if (!tasks.length) return null;
        return (
          <section key={id} aria-label={label} className="flex flex-col gap-1">
            <h3 className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
              {label}
              <span className="text-subtle-foreground tabular-nums">{tasks.length}</span>
            </h3>
            <TaskRows tasks={tasks} showRecord={props.showRecord} />
          </section>
        );
      })}
      {more}
    </div>
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
export function TaskRow(props: { task: CrmTask; showRecord: boolean }) {
  const { task } = props;
  const { href: inWorkspace } = useWorkspacePaths();
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
    <li className="group flex h-10 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors duration-150 ease-out hover:bg-hover">
      <CheckboxField
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        isSelected={done}
        onChange={toggle}
      >
        <Checkbox />
      </CheckboxField>
      <Link
        href={inWorkspace(`/crm/tasks/${encodeURIComponent(task.id)}`)}
        className={`min-w-0 flex-1 truncate text-sm ${done ? "text-muted-foreground" : "text-foreground"}`}
      >
        {task.title}
      </Link>
      {record && (
        <Link
          href={inWorkspace(`/crm/${record.kind}/${encodeURIComponent(record.id)}`)}
          className="flex max-w-48 min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground hover:text-foreground max-sm:hidden"
        >
          <RecordMark name={record.name} square={record.kind === "companies"} size={16} />
          <span className="truncate">{record.name}</span>
        </Link>
      )}
      <span
        className={`w-20 shrink-0 text-end text-xs tabular-nums ${overdue ? "text-danger" : "text-muted-foreground"}`}
      >
        {dueLabel(done ? task.completedAt : task.dueAt)}
      </span>
      <span className="flex w-5 shrink-0 justify-center" title={assignee?.name}>
        {assignee && <RecordMark name={assignee.name} size={20} />}
      </span>
    </li>
  );
}

function TaskBones() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 px-2">
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
