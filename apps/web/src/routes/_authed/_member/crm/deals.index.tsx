import { createFileRoute } from "@tanstack/react-router";
import { DealsPage } from "../../../../components/crm/list-pages.tsx";
import { crmDealsQuery } from "../../../../lib/crm.ts";
import { crmDealsSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/_member/crm/deals/")({
  validateSearch: crmDealsSearch,
  loaderDeps: ({ search }) => ({ q: search.q ?? "" }),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(crmDealsQuery(deps.q)),
  component: Deals,
});

function Deals() {
  const { q, view } = Route.useSearch();
  return <DealsPage q={q ?? ""} view={view ?? "board"} />;
}
