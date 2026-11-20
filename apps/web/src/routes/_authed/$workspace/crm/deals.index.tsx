import { createFileRoute } from "@tanstack/react-router";
import { DealsPage } from "../../../../components/crm/list-pages.tsx";
import { crmDealsQuery } from "../../../../lib/crm.ts";
import { dealsFilter } from "../../../../lib/crm-lists.ts";
import { crmDealsSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/deals/")({
  validateSearch: crmDealsSearch,
  loaderDeps: ({ search }) => dealsFilter(search, !search.q && search.view !== "list"),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(crmDealsQuery(deps)),
  component: Deals,
});

function Deals() {
  return <DealsPage search={Route.useSearch()} />;
}
