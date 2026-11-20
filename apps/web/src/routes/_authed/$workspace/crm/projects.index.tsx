import { createFileRoute } from "@tanstack/react-router";
import { ProjectsPage } from "../../../../components/crm/list-pages.tsx";
import { crmDealsQuery } from "../../../../lib/crm.ts";
import { projectsFilter } from "../../../../lib/crm-lists.ts";
import { crmProjectsSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/projects/")({
  validateSearch: crmProjectsSearch,
  loaderDeps: ({ search }) => projectsFilter(search),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(crmDealsQuery(deps)),
  component: Projects,
});

function Projects() {
  return <ProjectsPage search={Route.useSearch()} />;
}
