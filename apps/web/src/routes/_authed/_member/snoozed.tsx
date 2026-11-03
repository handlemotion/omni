import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/snoozed")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "snoozed", ...deps })),
  component: Snoozed,
});

function Snoozed() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title="Queue"
      filter={{ view: "snoozed", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/snoozed/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
