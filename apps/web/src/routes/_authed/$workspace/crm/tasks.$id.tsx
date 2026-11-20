import { createFileRoute, redirect } from "@tanstack/react-router";

/** An older link to a task's own page: tasks now open beside the list. */
export const Route = createFileRoute("/_authed/$workspace/crm/tasks/$id")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$workspace/crm/tasks",
      params: { workspace: params.workspace },
      search: { assignee: "anyone", task: params.id },
      replace: true,
    });
  },
});
