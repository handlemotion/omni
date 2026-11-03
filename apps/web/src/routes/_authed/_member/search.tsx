import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { List, type ListRow } from "../../../components/inbox/thread-list.tsx";
import { useSearch } from "../../../hooks/use-mail.ts";
import { searchQuery } from "../../../lib/mail-queries.ts";
import { searchSearch } from "../../../lib/search-params.ts";

// Smart search results (`?q=`) in the same list as the inbox; the search popover opens it.
export const Route = createFileRoute("/_authed/_member/search")({
  validateSearch: searchSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    if (deps.q.trim()) await context.queryClient.ensureQueryData(searchQuery(deps.q, deps.mailbox));
  },
  component: Search,
});

function Search() {
  const search = Route.useSearch();
  const router = useRouter();
  const { data: hits } = useSearch(search.q, search.mailbox);

  // One row per thread, best match first, with the passage that matched.
  const rows = useMemo(
    () =>
      (hits ?? []).map((hit): ListRow => ({
        id: hit.threadId,
        sender: hit.from.name || hit.from.address,
        subject: hit.subject,
        snippet: hit.snippet,
        unread: false,
      })),
    [hits],
  );

  return (
    <List
      title="Search results"
      caption={`Matching “${search.q}”`}
      rows={rows}
      href={(threadId) =>
        router.buildLocation({ to: "/search/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </List>
  );
}
