import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../-placeholders.tsx";

export const Route = createFileRoute("/_authed/_member/snoozed")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "snoozed", ...deps })),
  component: Snoozed,
});

function Snoozed() {
  const search = Route.useSearch();
  return (
    <ThreadList
      filter={{ view: "snoozed", ...search }}
      link={(threadId, children) => (
        <Link to="/snoozed/$threadId" params={{ threadId }} search={search}>
          {children}
        </Link>
      )}
    >
      <Outlet />
    </ThreadList>
  );
}
