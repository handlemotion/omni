import { createFileRoute } from "@tanstack/react-router";
import { PeoplePage } from "../../../../components/crm/list-pages.tsx";
import { crmPeopleQuery } from "../../../../lib/crm.ts";
import { peopleFilter } from "../../../../lib/crm-lists.ts";
import { crmPeopleSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/people/")({
  validateSearch: crmPeopleSearch,
  loaderDeps: ({ search }) => peopleFilter(search),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(crmPeopleQuery(deps)),
  component: People,
});

function People() {
  return <PeoplePage search={Route.useSearch()} />;
}
