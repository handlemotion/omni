import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/done")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "done", ...deps })),
  component: Done,
});

function Done() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title="Done"
      filter={{ view: "done", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/done/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
