import { router } from "expo-router";
import { CheckCircle } from "@/components/ui/check-circle.tsx";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import { dueLabel, isOverdue, useUpdateTask, type CrmTask } from "@/lib/crm-tasks.ts";

/**
 * A task in a list: its check, its title, the record it is on (and who has it, where the list
 * mixes people), and when it is due, in red once that has passed.
 */
export function TaskRow(props: { task: CrmTask; assignee?: string | null; onRecord?: boolean }) {
  const { task } = props;
  const update = useUpdateTask();
  const done = !!task.completedAt;
  const detail = [props.onRecord ? null : task.recordName, props.assignee]
    .filter(Boolean)
    .join(" · ");
  return (
    <ItemRow
      lead={
        <CheckCircle
          isSelected={done}
          label={`${done ? "Reopen" : "Complete"} ${task.title}`}
          onChange={(next) =>
            update.mutate(
              { id: task.id, done: next },
              { onError: (error) => crmErrorAlert(error, "The task was not changed") },
            )
          }
        />
      }
      title={task.title}
      detail={detail || null}
      trailing={done ? null : dueLabel(task.dueAt)}
      trailingTone={isOverdue(task) ? "danger" : "mutedForeground"}
      onPress={() => router.push({ pathname: "/crm/task/[id]", params: { id: task.id } })}
    />
  );
}
