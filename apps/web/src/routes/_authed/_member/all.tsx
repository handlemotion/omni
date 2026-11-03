import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../-placeholders.tsx";

export const Route = createFileRoute("/_authed/_member/all")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "all", ...deps })),
  component: AllMail,
});

function AllMail() {
  const search = Route.useSearch();
  return (
    <ThreadList
      filter={{ view: "all", ...search }}
      link={(threadId, children) => (
        <Link to="/all/$threadId" params={{ threadId }} search={search}>
          {children}
        </Link>
      )}
    >
      <Outlet />
    </ThreadList>
  );
}
