import { createFileRoute } from "@tanstack/react-router";
import { CompanyPage } from "../../../../components/crm/record-pages.tsx";
import { crmCompanyQuery, crmTimelineQuery } from "../../../../lib/crm.ts";
import { listSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/_member/crm/companies/$id")({
  validateSearch: listSearch,
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(crmCompanyQuery(params.id));
    void context.queryClient.prefetchInfiniteQuery(crmTimelineQuery("companies", params.id));
  },
  component: Company,
});

function Company() {
  const { id } = Route.useParams();
  return <CompanyPage key={id} id={id} />;
}
