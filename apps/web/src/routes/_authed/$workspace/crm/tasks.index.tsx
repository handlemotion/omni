import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "../../../../components/crm/tasks.tsx";
import { crmTasksSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/tasks/")({
  validateSearch: crmTasksSearch,
  component: Tasks,
});

function Tasks() {
  const { q, view, assignee, status, task } = Route.useSearch();
  const legacy = view === "all" || view === "done";
  return (
    <TasksPage
      q={q ?? ""}
      assignee={assignee ?? (legacy ? "anyone" : undefined)}
      status={status ?? (view === "done" ? "done" : undefined)}
      task={task}
    />
  );
}
