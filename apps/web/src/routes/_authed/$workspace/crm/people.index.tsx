import { createFileRoute } from "@tanstack/react-router";
import { PeoplePage } from "../../../../components/crm/list-pages.tsx";
import { crmPeopleQuery } from "../../../../lib/crm.ts";
import { crmListSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/people/")({
  validateSearch: crmListSearch,
  loaderDeps: ({ search }) => ({ q: search.q ?? "" }),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(crmPeopleQuery(deps.q)),
  component: People,
});

function People() {
  const { q } = Route.useSearch();
  return <PeoplePage q={q ?? ""} />;
}
