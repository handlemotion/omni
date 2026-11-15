import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { filesFromDraft } from "../../../components/compose/composer.tsx";
import { EmptyState } from "../../../components/empty/empty-state.tsx";
import { List, ListFailed, type ListRow } from "../../../components/inbox/thread-list.tsx";
import { useDrafts } from "../../../hooks/use-compose.ts";
import { reopenCompose } from "../../../hooks/use-compose-pane.ts";
import { draftsQuery } from "../../../lib/compose.ts";
import { draftsSearch } from "../../../lib/search-params.ts";

// Unsent mail, newest first: replies and forwards in progress (each opens its conversation with
// the draft in the composer) and new messages (each opens in the compose dialog).
export const Route = createFileRoute("/_authed/_member/drafts")({
  validateSearch: draftsSearch,
  loaderDeps: ({ search }) => ({ mailbox: search.mailbox }),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchQuery(draftsQuery({ mailboxId: deps.mailbox })),
  component: Drafts,
});

/** A new message's row id: it has no conversation to be named by. */
const NEW = "new:";

function Drafts() {
  const search = Route.useSearch();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const { data: drafts, isPending, isError, isSuccess, refetch } = useDrafts(search.mailbox);

  // One row per conversation (its newest draft), and one per new message.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (drafts ?? []).flatMap((draft): ListRow[] => {
      const id = draft.threadId ?? `${NEW}${draft.id}`;
      if (seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          sender: draft.to.map((a) => a.name || a.address).join(", "),
          subject: draft.subject || draft.threadSubject || "",
          snippet: draft.bodyText.replace(/\s+/g, " ").trim().slice(0, 200),
          unread: false,
        },
      ];
    });
  }, [drafts]);

  // `?draft=`: a new message's row was opened. It opens in the compose dialog, over the list.
  const opened = search.draft && drafts?.find((d) => d.id === search.draft);
  useEffect(() => {
    if (!opened) return;
    reopenCompose({
      mailboxId: opened.mailboxId,
      to: opened.to.map((a) => a.address),
      cc: opened.cc.map((a) => a.address),
      bcc: opened.bcc.map((a) => a.address),
      subject: opened.subject,
      text: opened.bodyText,
      files: filesFromDraft(opened),
    });
    void navigate({ search: ({ draft: _draft, ...rest }) => rest, replace: true });
  }, [opened, navigate]);

  return (
    <List
      title="Drafts"
      rows={rows}
      rowMenu={false}
      loading={isPending}
      empty={
        isError ? (
          <ListFailed retry={() => void refetch()} />
        ) : isSuccess ? (
          <EmptyState figure="drawer" title="No drafts" />
        ) : undefined
      }
      href={(id) =>
        id.startsWith(NEW)
          ? router.buildLocation({
              to: "/drafts",
              search: { ...search, draft: id.slice(NEW.length) },
            }).href
          : router.buildLocation({
              to: "/drafts/$threadId",
              params: { threadId: id },
              search: { mailbox: search.mailbox },
            }).href
      }
    >
      <Outlet />
    </List>
  );
}
