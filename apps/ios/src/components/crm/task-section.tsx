import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { CrmRecordKind } from "@/lib/crm-mutations.ts";
import { useMemberNames } from "@/lib/crm-timeline.ts";
import { recordFilter, useTasks } from "@/lib/crm-tasks.ts";
import { gutter } from "@/theme/tokens.ts";
import { TaskRow } from "./task-row.tsx";

/** Opens the new-task sheet, on a record when given one. */
export const openNewTask = (record?: { kind: CrmRecordKind; id: string }) =>
  router.push({ pathname: "/crm/task-new", params: record ?? {} });

/** A record's tasks, as the web's Tasks tab: the open ones, then the done ones, with Add task. */
export function TaskSection({ kind, id }: { kind: CrmRecordKind; id: string }) {
  const filter = recordFilter(kind, id);
  const openQuery = useTasks({ ...filter, status: "open" });
  const doneQuery = useTasks({ ...filter, status: "done" });
  const open = openQuery.data ?? [];
  const done = doneQuery.data ?? [];
  const names = useMemberNames().data;
  const assignee = (memberId: string | null) => (memberId ? names?.get(memberId) : null);
  return (
    <View>
      <View style={styles.header}>
        <Text size="sm" weight="medium" tone="mutedForeground" style={styles.title}>
          Tasks
        </Text>
        <Button intent="quiet" label="Add task" onPress={() => openNewTask({ kind, id })} />
      </View>
      {open.map((task) => (
        <TaskRow key={task.id} task={task} assignee={assignee(task.assigneeMemberId)} onRecord />
      ))}
      <More query={openQuery} />
      {done.length ? <SectionHeading label="Done" /> : null}
      {done.map((task) => (
        <TaskRow key={task.id} task={task} assignee={assignee(task.assigneeMemberId)} onRecord />
      ))}
      <More query={doneQuery} />
    </View>
  );
}

function More({ query }: { query: ReturnType<typeof useTasks> }) {
  if (!query.hasNextPage) return null;
  return (
    <View style={styles.more}>
      <Button
        intent="plain"
        label="Show more"
        isPending={query.isFetchingNextPage}
        onPress={() => void query.fetchNextPage()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: gutter },
  title: { flex: 1 },
  more: { paddingHorizontal: gutter, alignItems: "flex-start" },
});
