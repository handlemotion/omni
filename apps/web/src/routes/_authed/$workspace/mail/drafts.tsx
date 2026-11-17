import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { filesFromDraft } from "../../../../components/compose/composer.tsx";
import { EmptyState } from "../../../../components/empty/empty-state.tsx";
import { List, ListFailed, type ListRow } from "../../../../components/inbox/thread-list.tsx";
import { useDrafts } from "../../../../hooks/use-compose.ts";
import { reopenCompose } from "../../../../hooks/use-compose-pane.ts";
import { draftsQuery } from "../../../../lib/compose.ts";
import { draftsSearch } from "../../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/$workspace/mail/drafts")({
  validateSearch: draftsSearch,
  loaderDeps: ({ search }) => ({ mailbox: search.mailbox }),
  loader: ({ context, deps }) =>
    void context.queryClient.prefetchQuery(draftsQuery({ mailboxId: deps.mailbox })),
  component: Drafts,
});

const NEW = "new:";

function Drafts() {
  const search = Route.useSearch();
  const router = useRouter();
  const { workspace } = Route.useParams();
  const navigate = Route.useNavigate();
  const { data: drafts, isPending, isError, isSuccess, refetch } = useDrafts(search.mailbox);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (drafts ?? []).flatMap((draft) => {
      const id = draft.threadId ?? `${NEW}${draft.id}`;
      if (seen.has(id)) {
        const result: ListRow[] = [];
        return result;
      }
      seen.add(id);
      const result: ListRow[] = [
        {
          id,
          sender: draft.to.map((a) => a.name || a.address).join(", "),
          subject: draft.subject || draft.threadSubject || "",
          snippet: draft.bodyText.replace(/\s+/g, " ").trim().slice(0, 200),
          unread: false,
        },
      ];
      return result;
    });
  }, [drafts]);

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
              to: "/$workspace/mail/drafts",
              params: { workspace },
              search: { ...search, draft: id.slice(NEW.length) },
            }).href
          : router.buildLocation({
              to: "/$workspace/mail/drafts/$threadId",
              params: { workspace, threadId: id },
              search: { mailbox: search.mailbox },
            }).href
      }
    >
      <Outlet />
    </List>
  );
}
