import { createFileRoute } from "@tanstack/react-router";
import { TaskPage } from "../../../../components/crm/task-page.tsx";
import { crmTaskQuery } from "../../../../lib/crm-tasks.ts";
import { listSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/tasks/$id")({
  validateSearch: listSearch,
  loader: ({ context, params }) => void context.queryClient.prefetchQuery(crmTaskQuery(params.id)),
  component: Task,
});

function Task() {
  const { id } = Route.useParams();
  return <TaskPage key={id} id={id} />;
}
