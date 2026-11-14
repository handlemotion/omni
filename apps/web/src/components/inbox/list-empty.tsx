// What an empty list says and offers, per view: a title, one short line on what lands there, and
// the way out. A filtered list offers to clear its filters first (primary); the next place worth
// going follows as a tertiary (outline) button.
import { useNavigate } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty/empty-state";
import { openSearch } from "@/components/search/search-popover";
import { Button } from "@/components/ui/button";
import { useOpenCompose } from "@/hooks/use-compose-pane.ts";
import type { ConversationFilter, HelpdeskView, ThreadFilter, ThreadView } from "@/lib/types.ts";

const VIEW_TEXT: Record<ThreadView, { title: string; description: string }> = {
  inbox: { title: "Inbox zero", description: "You're all caught up. New mail lands here." },
  later: {
    title: "Nothing for later",
    description: "Snooze a thread to park it here until you're ready for it.",
  },
  done: {
    title: "Nothing done yet",
    description: "Threads you mark done move here, out of your Inbox.",
  },
  archive: { title: "Nothing archived", description: "Threads you archive are kept here." },
  all: {
    title: "No mail yet",
    description: "Mail from your connected accounts shows up here once it syncs.",
  },
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
  inbox: "/inbox",
  later: "/later",
  done: "/done",
  archive: "/archive",
  all: "/all",
} as const satisfies Record<ThreadView, string>;

/** An empty thread list (Inbox, Later, Done, Archive, All mail). */
export function ThreadListEmpty(props: { filter: ThreadFilter }) {
  const navigate = useNavigate();
  const openCompose = useOpenCompose();
  const { view, mailbox, lane } = props.filter;
  const text = (view === "inbox" && lane && LANE_TEXT[lane]) || VIEW_TEXT[view];
  const filtered = !!(mailbox || lane);
  const clear = () => void navigate({ to: VIEW_PATH[view], search: {} });
  // Where to go next: All mail from the Inbox and Archive, the Inbox from Later and Done.
  const next =
    view === "all"
      ? { label: "Compose", go: openCompose }
      : view === "inbox" || view === "archive"
        ? { label: "All mail", go: () => void navigate({ to: "/all", search: { mailbox } }) }
        : { label: "Go to Inbox", go: () => void navigate({ to: "/inbox", search: { mailbox } }) };
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
  snoozed: {
    title: "Nothing snoozed",
    description: "Snoozed conversations rest here until they're due.",
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
  const { mailbox, view, tag } = props.filter;
  const text = HELPDESK_TEXT[view];
  const showAll = view !== "all";
  return (
    <EmptyState figure="drawer" title={text.title} description={text.description}>
      {tag && (
        <Button
          size="sm"
          onPress={() => void navigate({ to: "/inbox", search: { mailbox, view } })}
        >
          Clear filters
        </Button>
      )}
      {showAll && (
        <Button
          size="sm"
          intent={tag ? "outline" : "primary"}
          onPress={() => void navigate({ to: "/inbox", search: { mailbox, view: "all" } })}
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
          onPress={() => void navigate({ to: "/search", search: { q: props.q } })}
        >
          Search all inboxes
        </Button>
      ) : (
        <Button
          size="sm"
          intent="outline"
          onPress={() => void navigate({ to: "/all", search: {} })}
        >
          All mail
        </Button>
      )}
    </EmptyState>
  );
}
