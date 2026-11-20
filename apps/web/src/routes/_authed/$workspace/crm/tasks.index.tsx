import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "../../../../components/crm/tasks.tsx";
import { crmTasksSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/tasks/")({
  validateSearch: crmTasksSearch,
  component: Tasks,
});

function Tasks() {
  const { q, view, assignee } = Route.useSearch();
  return <TasksPage q={q ?? ""} view={view ?? "mine"} assignee={assignee} />;
}
