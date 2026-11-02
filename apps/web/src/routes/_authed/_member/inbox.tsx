import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { inboxSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../-placeholders.tsx";

export const Route = createFileRoute("/_authed/_member/inbox")({
  validateSearch: inboxSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "inbox", ...deps })),
  component: Inbox,
});

function Inbox() {
  const search = Route.useSearch();
  return (
    <ThreadList
      filter={{ view: "inbox", ...search }}
      link={(threadId, children) => (
        <Link to="/inbox/$threadId" params={{ threadId }} search={search}>
          {children}
        </Link>
      )}
    >
      <Outlet />
    </ThreadList>
  );
}
