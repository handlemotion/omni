import { createFileRoute, redirect } from "@tanstack/react-router";
import { TasksPage } from "../../../../components/crm/tasks.tsx";
import { crmTasksSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/tasks/")({
  validateSearch: crmTasksSearch,
  beforeLoad: ({ params, search }) => {
    if (!search.view) return;
    const { view, ...rest } = search;
    const legacy = view === "all" || view === "done";
    throw redirect({
      to: "/$workspace/crm/tasks",
      params,
      search: {
        ...rest,
        assignee: rest.assignee ?? (legacy ? "anyone" : undefined),
        status: rest.status ?? (view === "done" ? "done" : undefined),
      },
      replace: true,
    });
  },
  component: Tasks,
});

function Tasks() {
  const { q, assignee, status, task } = Route.useSearch();
  return <TasksPage q={q ?? ""} assignee={assignee} status={status} task={task} />;
}
