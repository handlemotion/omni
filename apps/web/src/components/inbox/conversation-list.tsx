import { useMemo, type ReactNode } from "react";
import { IconCheck, IconCircleCheck, IconPlus, IconUserCog } from "@/components/icons/central";
import { viewLabel } from "@/components/shell/helpdesk-nav";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import {
  useAssignees,
  useConversationChanges,
  useConversations,
  useTags,
} from "@/hooks/use-conversation.ts";
import { runShortcut } from "@/hooks/use-shortcuts.ts";
import { useUndo } from "@/hooks/use-undo.ts";
import { inverseOf, type ConversationChange } from "@/lib/conversations.ts";
import { senderAddress, senderLabel } from "@/lib/threads.ts";
import type { ConversationFilter, ConversationSummary } from "@/lib/types.ts";
import { offerUndo } from "@/lib/undo.ts";
import type { ConversationRowInfo } from "./conversation-meta";
import { ConversationListEmpty } from "@/components/inbox/list-empty";
import { List, ListFailed, type ListRow } from "./thread-list";

const MIXED = new Set<ConversationFilter["view"]>(["mine", "all"]);

export function ConversationList(props: {
  filter: ConversationFilter;
  href: (threadId: string) => string;
  children?: ReactNode;
}) {
  const { filter } = props;
  const query = useConversations(filter);
  const { conversations, hasNextPage, fetchNextPage, isFetchingNextPage } = query;
  const assignees = useAssignees(filter.mailbox).data;
  const rows = useMemo(() => {
    const people = new Map(assignees?.map((a) => [a.memberId, a]));
    return conversations.map((c) => {
      const assignee = c.assigneeMemberId ? people.get(c.assigneeMemberId) : undefined;
      const info: ConversationRowInfo = {
        status: MIXED.has(filter.view) ? c.status : undefined,
        priority: c.priority,
        tags: c.tags,
        slaDueAt: c.status === "open" ? c.slaDueAt : null,
        hasAttachments: c.hasAttachments,
        assignee: assignee ? { name: assignee.name, image: assignee.image } : null,
        lastMessageAt: c.lastMessageAt,
      };
      const result: ListRow = {
        id: c.id,
        sender: senderLabel(c),
        senderAddress: senderAddress(c),
        subject: c.subject,
        snippet: c.snippet,
        unread: c.unread,
        conversation: info,
      };
      return result;
    });
  }, [conversations, assignees, filter.view]);
  const loadMore = useMemo(
    () => (hasNextPage ? () => void fetchNextPage() : undefined),
    [hasNextPage, fetchNextPage],
  );
  const title = viewLabel(filter.view);

  return (
    <List
      title={title}
      href={props.href}
      rows={rows}
      loading={query.isPending}
      caption={filter.view === "sla_at_risk" ? "Soonest due" : undefined}
      shortcuts={{ view: "inbox", threads: [], loadMore, helpdesk: { filter, conversations } }}
      loadMore={loadMore}
      isLoadingMore={isFetchingNextPage}
      bulkActions={({ ids, clear }) => (
        <BulkActions
          filter={filter}
          rows={conversations.filter((c) => ids.includes(c.id))}
          clear={clear}
        />
      )}
      empty={
        query.isError ? (
          <ListFailed retry={() => void query.refetch()} />
        ) : query.isSuccess ? (
          <ConversationListEmpty filter={filter} />
        ) : undefined
      }
    >
      {props.children}
    </List>
  );
}

function BulkActions(props: {
  filter: ConversationFilter;
  rows: ConversationSummary[];
  clear: () => void;
}) {
  const { filter, rows, clear } = props;
  const changes = useConversationChanges();
  const tags = useTags(filter.mailbox).data ?? [];
  useUndo();
  const resolved = rows.length > 0 && rows.every((r) => r.status === "resolved");

  const apply = (make: (row: ConversationSummary) => ConversationChange, said: string) => {
    const batch = rows.map((row) => ({ row, change: make(row) }));
    for (const { row, change } of batch) {
      const tag = change.type === "tag" ? tags.find((t) => t.id === change.tagId) : undefined;
      changes.run(row.id, change, { undo: false, tag, mailboxId: filter.mailbox });
    }
    clear();
    offerUndo(said, () => {
      for (const { row, change } of batch) {
        const inverse = inverseOf(row, change);
        const tag =
          inverse?.type === "tag" ? row.tags.find((t) => t.id === inverse.tagId) : undefined;
        if (inverse) changes.run(row.id, inverse, { undo: false, tag, mailboxId: filter.mailbox });
      }
    });
  };

  return (
    <div className="flex items-center gap-1">
      <span className="me-2 translate-y-px text-xs text-subtle-foreground tabular-nums">
        {rows.length} selected
      </span>
      <Button intent="plain" size="sm" onPress={() => runShortcut("assignToMe")}>
        <IconUserCog />
        Assign to me
      </Button>
      <Button intent="plain" size="sm" onPress={() => runShortcut("resolve")}>
        <IconCircleCheck />
        {resolved ? "Reopen" : "Resolve"}
      </Button>
      {tags.length > 0 && (
        <MenuTrigger>
          <Button intent="plain" size="sm">
            Tag
          </Button>
          <Menu placement="bottom start">
            {tags.map((tag) => {
              const all = rows.every((r) => r.tags.some((t) => t.id === tag.id));
              return (
                <MenuItem
                  key={tag.id}
                  textValue={tag.name}
                  onAction={() =>
                    apply(
                      () => ({ type: "tag", tagId: tag.id, add: !all }),
                      all ? `Removed ${tag.name}` : `Tagged ${tag.name}`,
                    )
                  }
                >
                  {all ? <IconCheck data-slot="icon" /> : <IconPlus data-slot="icon" />}
                  <MenuLabel>{tag.name}</MenuLabel>
                </MenuItem>
              );
            })}
          </Menu>
        </MenuTrigger>
      )}
    </div>
  );
}
