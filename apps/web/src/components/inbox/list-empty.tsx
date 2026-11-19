import { useNavigate } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty/empty-state";
import { openSearch } from "@/components/search/command-menu";
import { Button } from "@/components/ui/button";
import { useOpenCompose } from "@/hooks/use-compose-pane.ts";
import type { ConversationFilter, HelpdeskView, ThreadFilter, ThreadView } from "@/lib/types.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";

const VIEW_TEXT: Record<ThreadView, { title: string; description?: string }> = {
  inbox: { title: "Inbox zero", description: "You're all caught up. New mail lands here." },
  later: { title: "Nothing for later" },
  done: {
    title: "Nothing done yet",
    description: "Threads you mark done move here, out of your Inbox.",
  },
  archive: { title: "Nothing archived", description: "Threads you archive are kept here." },
  all: {
    title: "No mail yet",
    description: "Mail from your connected accounts shows up here once it syncs.",
  },
  sent: { title: "Nothing sent yet" },
  trash: { title: "Trash is empty" },
  spam: { title: "No spam" },
};

const LANE_TEXT: Partial<Record<string, { title: string; description: string }>> = {
  needs_reply: {
    title: "Nothing needs a reply",
    description: "Threads waiting on an answer from you show up here.",
  },
  waiting_on_them: {
    title: "Not waiting on anyone",
    description: "Threads where you're waiting on someone else's reply show up here.",
  },
};

const VIEW_PATH = {
  inbox: "/$workspace/mail/inbox",
  later: "/$workspace/mail/later",
  done: "/$workspace/mail/done",
  archive: "/$workspace/mail/archive",
  all: "/$workspace/mail/all",
  sent: "/$workspace/mail/sent",
  trash: "/$workspace/mail/trash",
  spam: "/$workspace/mail/spam",
} as const satisfies Record<ThreadView, string>;

/** An empty thread list (Inbox, Later, Done, Archive, All mail). */
export function ThreadListEmpty(props: { filter: ThreadFilter }) {
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const openCompose = useOpenCompose();
  const { view, mailbox, lane } = props.filter;
  const text = (view === "inbox" && lane && LANE_TEXT[lane]) || VIEW_TEXT[view];
  const filtered = !!(mailbox || lane);
  const clear = () => void navigate({ to: VIEW_PATH[view], params: { workspace }, search: {} });
  const next =
    view === "all"
      ? { label: "Compose", go: openCompose }
      : view === "inbox" || view === "archive"
        ? {
            label: "All mail",
            go: () =>
              void navigate({
                to: "/$workspace/mail/all",
                params: { workspace },
                search: { mailbox },
              }),
          }
        : {
            label: "Go to Inbox",
            go: () =>
              void navigate({
                to: "/$workspace/mail/inbox",
                params: { workspace },
                search: { mailbox },
              }),
          };
  return (
    <EmptyState
      figure={view === "archive" ? "cabinet" : "drawer"}
      title={text.title}
      description={text.description}
    >
      {filtered && (
        <Button size="sm" onPress={clear}>
          Clear filters
        </Button>
      )}
      <Button size="sm" intent={filtered ? "outline" : "primary"} onPress={next.go}>
        {next.label}
      </Button>
    </EmptyState>
  );
}

const HELPDESK_TEXT: Record<HelpdeskView, { title: string; description: string }> = {
  unassigned: {
    title: "Nothing waiting for an owner",
    description: "New conversations without an owner show up here.",
  },
  mine: {
    title: "Nothing assigned to you",
    description: "Conversations assigned to you show up here.",
  },
  open: {
    title: "No open conversations",
    description: "Conversations still in progress show up here.",
  },
  pending: {
    title: "Nothing waiting on a customer",
    description: "Conversations waiting on the customer's reply show up here.",
  },
  resolved: { title: "Nothing resolved yet", description: "Resolved conversations are kept here." },
  sla_at_risk: {
    title: "No SLA due soon",
    description: "Conversations close to their SLA deadline show up here.",
  },
  all: {
    title: "No conversations",
    description: "Conversations sent to this inbox show up here.",
  },
};

/** An empty helpdesk view: clear its tag, or widen to every conversation in the inbox. */
export function ConversationListEmpty(props: { filter: ConversationFilter }) {
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const { mailbox, view, tag } = props.filter;
  const text = HELPDESK_TEXT[view];
  const showAll = view !== "all";
  return (
    <EmptyState figure="drawer" title={text.title} description={text.description}>
      {tag && (
        <Button
          size="sm"
          onPress={() =>
            void navigate({
              to: "/$workspace/mail/inbox",
              params: { workspace },
              search: { mailbox, view },
            })
          }
        >
          Clear filters
        </Button>
      )}
      {showAll && (
        <Button
          size="sm"
          intent={tag ? "outline" : "primary"}
          onPress={() =>
            void navigate({
              to: "/$workspace/mail/inbox",
              params: { workspace },
              search: { mailbox, view: "all" },
            })
          }
        >
          All conversations
        </Button>
      )}
    </EmptyState>
  );
}

/** No search results: change the search, or widen it past one inbox. */
export function SearchEmpty(props: { q: string; mailbox?: string | undefined }) {
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  return (
    <EmptyState
      figure="loupe"
      title="No matches"
      description={`Nothing matches “${props.q}”. Try fewer words, a sender, or a date.`}
    >
      <Button size="sm" onPress={() => openSearch({ q: props.q, mailbox: props.mailbox })}>
        Edit search
      </Button>
      {props.mailbox ? (
        <Button
          size="sm"
          intent="outline"
          onPress={() =>
            void navigate({
              to: "/$workspace/mail/search",
              params: { workspace },
              search: { q: props.q },
            })
          }
        >
          Search all inboxes
        </Button>
      ) : (
        <Button
          size="sm"
          intent="outline"
          onPress={() =>
            void navigate({ to: "/$workspace/mail/all", params: { workspace }, search: {} })
          }
        >
          All mail
        </Button>
      )}
    </EmptyState>
  );
}
