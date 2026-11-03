import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { inboxSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/inbox")({
  validateSearch: inboxSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "inbox", ...deps })),
  component: Inbox,
});

// The sidebar's names for the lanes it links to.
const LANE_TITLES: Partial<Record<string, string>> = {
  needs_reply: "Needs reply",
  waiting_on_them: "Awaiting reply",
};

function Inbox() {
  const search = Route.useSearch();
  const router = useRouter();
  return (
    <ThreadList
      title={(search.lane && LANE_TITLES[search.lane]) || "Inbox"}
      filter={{ view: "inbox", ...search }}
      href={(threadId) =>
        router.buildLocation({ to: "/inbox/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
