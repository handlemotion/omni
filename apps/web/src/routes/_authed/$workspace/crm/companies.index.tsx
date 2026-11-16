import { createFileRoute } from "@tanstack/react-router";
import { CompaniesPage } from "../../../../components/crm/list-pages.tsx";
import { crmCompaniesQuery } from "../../../../lib/crm.ts";
import { crmListSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/companies/")({
  validateSearch: crmListSearch,
  loaderDeps: ({ search }) => ({ q: search.q ?? "" }),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(crmCompaniesQuery(deps.q)),
  component: Companies,
});

function Companies() {
  const { q } = Route.useSearch();
  return <CompaniesPage q={q ?? ""} />;
}
