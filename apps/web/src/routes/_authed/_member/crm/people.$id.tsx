import { createFileRoute } from "@tanstack/react-router";
import { PersonPage } from "../../../../components/crm/record-pages.tsx";
import { crmPersonQuery, crmTimelineQuery } from "../../../../lib/crm.ts";
import { listSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/_member/crm/people/$id")({
  validateSearch: listSearch,
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(crmPersonQuery(params.id));
    void context.queryClient.prefetchInfiniteQuery(crmTimelineQuery("people", params.id));
  },
  component: Person,
});

function Person() {
  const { id } = Route.useParams();
  return <PersonPage key={id} id={id} />;
}
