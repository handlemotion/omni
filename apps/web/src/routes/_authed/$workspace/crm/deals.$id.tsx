import { createFileRoute } from "@tanstack/react-router";
import { DealPage } from "../../../../components/crm/record-pages.tsx";
import { crmDealQuery, crmTimelineQuery } from "../../../../lib/crm.ts";
import { crmRecordSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/crm/deals/$id")({
  validateSearch: crmRecordSearch,
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(crmDealQuery(params.id));
    void context.queryClient.prefetchInfiniteQuery(crmTimelineQuery("deals", params.id));
  },
  component: Deal,
});

function Deal() {
  const { id } = Route.useParams();
  return <DealPage key={id} id={id} />;
}
