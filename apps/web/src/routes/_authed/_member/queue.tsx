import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/queue")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "queue", ...deps })),
  component: Queue,
});

function Queue() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title="Queue"
      filter={{ view: "queue", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/queue/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
