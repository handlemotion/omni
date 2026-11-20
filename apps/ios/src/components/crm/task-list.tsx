import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { IconChecklist } from "@/components/icons.ts";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { useMemberNames } from "@/lib/crm-timeline.ts";
import {
  DUE_GROUPS,
  TASK_VIEWS,
  dueGroup,
  useTaskCounts,
  useTasks,
  type CrmTask,
  type TaskView,
} from "@/lib/crm-tasks.ts";
import { gutter, space } from "@/theme/tokens.ts";
import { TaskRow } from "./task-row.tsx";

const EMPTY: Record<TaskView, string> = {
  mine: "Nothing on your list",
  all: "No open tasks",
  done: "No finished tasks",
};

function byDue(tasks: CrmTask[]) {
  const now = new Date();
  return DUE_GROUPS.flatMap((group) => {
    const inGroup = tasks.filter((task) => dueGroup(task, now) === group.id);
    if (!inGroup.length) return [];
    return [
      { kind: "heading" as const, id: group.id, label: group.label },
      ...inGroup.map((task) => ({ kind: "task" as const, task })),
    ];
  });
}

const asRows = (tasks: CrmTask[]) => tasks.map((task) => ({ kind: "task" as const, task }));

/** The Tasks page: yours, everyone's open ones, or the done ones, as the web's Tasks list. */
export function TaskList(props: { footerSpace?: number }) {
  const [view, setView] = useState<TaskView>("mine");
  const counts = useTaskCounts().data;
  const names = useMemberNames().data;
  const query = useTasks(TASK_VIEWS[view].filter);
  const rows = useCallback(
    (tasks: CrmTask[]) => (view === "done" ? asRows(tasks) : byDue(tasks)),
    [view],
  );
  const count = { mine: counts?.mine, all: counts?.open, done: null };
  return (
    <View style={styles.page}>
      <View style={styles.views}>
        <Segmented
          value={view}
          onChange={setView}
          options={(Object.keys(TASK_VIEWS) as TaskView[]).map((id) => ({
            id,
            label: TASK_VIEWS[id].label,
            count: count[id],
          }))}
        />
      </View>
      <InfiniteList
        key={view}
        query={query}
        rows={rows}
        keyOf={(row) => (row.kind === "heading" ? `h:${row.id}` : row.task.id)}
        typeOf={(row) => row.kind}
        renderItem={(row) =>
          row.kind === "heading" ? (
            <SectionHeading label={row.label} />
          ) : (
            <TaskRow
              task={row.task}
              assignee={
                view === "mine" || !row.task.assigneeMemberId
                  ? null
                  : names?.get(row.task.assigneeMemberId)
              }
            />
          )
        }
        icon={IconChecklist}
        empty={EMPTY[view]}
        footerSpace={props.footerSpace}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  views: { paddingHorizontal: gutter, paddingVertical: space(2) },
});
