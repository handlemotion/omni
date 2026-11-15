import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/trash")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(threadsQuery({ view: "trash", ...deps })),
  component: TrashMail,
});

function TrashMail() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title="Trash"
      filter={{ view: "trash", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/trash/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
