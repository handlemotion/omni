import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { SearchEmpty } from "../../../../components/inbox/list-empty.tsx";
import { List, type ListRow } from "../../../../components/inbox/thread-list.tsx";
import { useSearch } from "../../../../hooks/use-mail.ts";
import { searchQuery } from "../../../../lib/mail-queries.ts";
import { searchSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/mail/search")({
  validateSearch: searchSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    if (deps.q.trim()) void context.queryClient.prefetchQuery(searchQuery(deps.q, deps.mailbox));
  },
  component: Search,
});

function Search() {
  const search = Route.useSearch();
  const router = useRouter();
  const { workspace } = Route.useParams();
  const { data: hits, isPending, isSuccess } = useSearch(search.q, search.mailbox);

  const rows = useMemo(
    () =>
      (hits ?? []).map((hit) => {
        const result: ListRow = {
          id: hit.threadId,
          sender: hit.from.name || hit.from.address,
          senderAddress: hit.from.address,
          subject: hit.subject,
          snippet: hit.snippet,
          unread: hit.unread,
          triage: { done: false, later: false, lastMessageAt: hit.lastMessageAt },
        };
        return result;
      }),
    [hits],
  );

  return (
    <List
      title="Search results"
      caption={`Matching “${search.q}”`}
      rows={rows}
      loading={isPending && !!search.q.trim()}
      empty={isSuccess ? <SearchEmpty q={search.q} mailbox={search.mailbox} /> : undefined}
      href={(threadId) =>
        router.buildLocation({
          to: "/$workspace/mail/search/$threadId",
          params: { workspace, threadId },
          search,
        }).href
      }
    >
      <Outlet />
    </List>
  );
}
