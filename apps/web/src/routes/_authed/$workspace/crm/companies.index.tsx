import { createFileRoute } from "@tanstack/react-router";
import { CompaniesPage } from "../../../../components/crm/list-pages.tsx";
import { crmCompaniesQuery } from "../../../../lib/crm.ts";
import { companiesFilter } from "../../../../lib/crm-lists.ts";
import { crmCompaniesSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/companies/")({
  validateSearch: crmCompaniesSearch,
  loaderDeps: ({ search }) => companiesFilter(search),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(crmCompaniesQuery(deps)),
  component: Companies,
});

function Companies() {
  return <CompaniesPage search={Route.useSearch()} />;
}
