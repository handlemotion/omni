import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/all")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "all", ...deps })),
  component: AllMail,
});

function AllMail() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title="All mail"
      filter={{ view: "all", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/all/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
