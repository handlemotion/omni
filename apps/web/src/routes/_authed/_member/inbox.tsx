import { createFileRoute, Navigate, Outlet, useRouter } from "@tanstack/react-router";
import { conversationsQuery } from "../../../lib/conversations.ts";
import { threadsQuery } from "../../../lib/mail-queries.ts";
import { inboxSearch } from "../../../lib/search-params.ts";
import { ConversationList } from "../../../components/inbox/conversation-list.tsx";
import { ThreadList } from "../../../components/inbox/thread-list.tsx";
import { DEFAULT_VIEW } from "../../../components/shell/helpdesk-nav.tsx";
import { useAllMailboxes } from "../../../hooks/use-mail.ts";

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
  const href = (threadId: string) =>
    router.buildLocation({ to: "/inbox/$threadId", params: { threadId }, search }).href;
  const shared = useAllMailboxes().data?.some(
    (box) => box.id === search.mailbox && box.kind === "shared",
  );
  // A shared inbox is a helpdesk queue: it opens on a view, and lists conversations.
  if (shared && !search.view) {
    return <Navigate to="." search={{ ...search, view: DEFAULT_VIEW }} replace />;
  }
  if (search.mailbox && search.view) {
    return (
      <ConversationList
        filter={{ mailbox: search.mailbox, view: search.view, tag: search.tag }}
        href={href}
      >
        <Outlet />
      </ConversationList>
    );
  }
  return (
    <ThreadList
      title={(search.lane && LANE_TITLES[search.lane]) || "Inbox"}
      filter={{ view: "inbox", mailbox: search.mailbox, lane: search.lane }}
      href={href}
    >
      <Outlet />
    </ThreadList>
  );
}
