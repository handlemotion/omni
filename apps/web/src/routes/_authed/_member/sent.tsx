import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { listSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/sent")({
  validateSearch: listSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchInfiniteQuery(threadsQuery({ view: "sent", ...deps })),
  component: SentMail,
});

function SentMail() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title="Sent"
      filter={{ view: "sent", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/sent/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
