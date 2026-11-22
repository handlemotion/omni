import { useNavigate } from "@tanstack/react-router";
import {
  IconArrowUpRight,
  IconBuildings,
  IconCircle,
  IconCircleCheck,
  IconHandshake,
  IconTrash,
  IconUserRound,
} from "@/components/icons/central";
import type { ContextMenuEntry } from "@/components/ui/context-menu";
import { useDeleteTask, useUpdateTask } from "@/hooks/use-crm-tasks.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { taskRecord, type CrmTask } from "@/lib/crm-tasks.ts";
import { crmErrorToast } from "./crm-errors.ts";

const RECORD_ICON = { companies: IconBuildings, people: IconUserRound, deals: IconHandshake };

/**
 * A task's right-click rows: Open, Complete or Reopen, its record, and Delete (as the panel's
 * trash button, without asking). `href` is where Open leads from this list.
 */
export function useTaskMenu() {
  const navigate = useNavigate();
  const { href: inWorkspace } = useWorkspacePaths();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  return (task: CrmTask, href: string) => {
    const done = !!task.completedAt;
    const record = taskRecord(task);
    return [
      { icon: IconArrowUpRight, label: "Open", onAction: () => void navigate({ href }) },
      record && {
        icon: RECORD_ICON[record.kind],
        label: record.name ? `Open ${record.name}` : "Open record",
        onAction: () =>
          void navigate({
            href: inWorkspace(`/crm/${record.kind}/${encodeURIComponent(record.id)}`),
          }),
      },
      "separator",
      {
        icon: done ? IconCircle : IconCircleCheck,
        label: done ? "Reopen" : "Complete",
        onAction: () =>
          update.mutate(
            { id: task.id, done: !done },
            { onError: (error) => crmErrorToast(error, "The task was not changed") },
          ),
      },
      "separator",
      {
        icon: IconTrash,
        label: "Delete task",
        danger: true,
        onAction: () =>
          remove.mutate(task.id, {
            onError: (error) => crmErrorToast(error, "The task was not deleted"),
          }),
      },
    ] satisfies ContextMenuEntry[];
  };
}
