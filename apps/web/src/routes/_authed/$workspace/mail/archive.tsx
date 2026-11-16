import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../../lib/mail-queries.ts";
import { listSearch } from "../../../../lib/search-params.ts";
import { ThreadList } from "../../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/$workspace/mail/archive")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(threadsQuery({ view: "archive", ...deps })),
  component: Archive,
});

function Archive() {
  const search = Route.useSearch();
  const router = useRouter();
  const { workspace } = Route.useParams();
  return (
    <ThreadList
      title="Archive"
      filter={{ view: "archive", ...search }}
      href={(threadId) =>
        router.buildLocation({
          to: "/$workspace/mail/archive/$threadId",
          params: { workspace, threadId },
          search,
        }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
