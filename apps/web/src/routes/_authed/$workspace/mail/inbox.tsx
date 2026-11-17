import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { conversationsQuery } from "../../../../lib/conversations.ts";
import { threadsQuery } from "../../../../lib/mail-queries.ts";
import { inboxSearch } from "../../../../lib/search-params.ts";
import { ConversationList } from "../../../../components/inbox/conversation-list.tsx";
import { NoInboxes } from "../../../../components/inbox/no-inboxes.tsx";
import { ThreadList } from "../../../../components/inbox/thread-list.tsx";
import { useMailboxes } from "../../../../hooks/use-mail.ts";

export const Route = createFileRoute("/_authed/$workspace/mail/inbox")({
  validateSearch: inboxSearch,
  loaderDeps: ({ search: { mailbox, lane, view, tag } }) => ({ mailbox, lane, view, tag }),
  loader: ({ context, deps: { mailbox, lane, view, tag } }) =>
    void (mailbox && view
      ? context.queryClient.prefetchInfiniteQuery(conversationsQuery({ mailbox, view, tag }))
      : context.queryClient.prefetchInfiniteQuery(threadsQuery({ view: "inbox", mailbox, lane }))),
  component: Inbox,
});

const LANE_TITLES: Partial<Record<string, string>> = {
  needs_reply: "Needs reply",
  waiting_on_them: "Awaiting reply",
};

function Inbox() {
  const search = Route.useSearch();
  const router = useRouter();
  const { workspace } = Route.useParams();
  const href = (threadId: string) =>
    router.buildLocation({
      to: "/$workspace/mail/inbox/$threadId",
      params: { workspace, threadId },
      search,
    }).href;
  const mailboxes = useMailboxes().data;
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
      empty={mailboxes?.length === 0 ? <NoInboxes /> : undefined}
    >
      <Outlet />
    </ThreadList>
  );
}
