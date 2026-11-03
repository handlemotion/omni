import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/archive")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "archive", ...deps })),
  component: Archive,
});

function Archive() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title="Archive"
      filter={{ view: "archive", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/archive/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
