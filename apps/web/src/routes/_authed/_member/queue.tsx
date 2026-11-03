import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../-placeholders.tsx";

export const Route = createFileRoute("/_authed/_member/queue")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "queue", ...deps })),
  component: Queue,
});

function Queue() {
  const search = Route.useSearch();
  return (
    <ThreadList
      filter={{ view: "queue", ...search }}
      link={(threadId, children) => (
        <Link to="/queue/$threadId" params={{ threadId }} search={search}>
          {children}
        </Link>
      )}
    >
      <Outlet />
    </ThreadList>
  );
}
