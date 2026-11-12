import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { conversationsQuery } from "../../../lib/conversations.ts";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { inboxSearch } from "../../../lib/search-params.ts";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";

export const Route = createFileRoute("/_authed/_member/inbox")({
  validateSearch: inboxSearch,
  loaderDeps: ({ search: { mailbox, lane, view, tag } }) => ({ mailbox, lane, view, tag }),
  // A shared inbox's helpdesk view (`?mailbox=…&view=…`) lists conversations; the rest, threads.
  loader: ({ context, deps: { mailbox, lane, view, tag } }) =>
    mailbox && view
      ? context.queryClient.ensureInfiniteQueryData(conversationsQuery({ mailbox, view, tag }))
      : context.queryClient.ensureInfiniteQueryData(threadsQuery({ view: "inbox", mailbox, lane })),
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
      filter={{ view: "inbox", mailbox: search.mailbox, lane: search.lane }}
      href={(threadId) =>
        router.buildLocation({ to: "/inbox/$threadId", params: { threadId }, search }).href
      }
    >
      <Outlet />
    </ThreadList>
  );
}
