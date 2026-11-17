import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { requestCompose } from "../../../../components/compose/composer-state.tsx";
import { Conversation } from "../../../../components/conversation/conversation.tsx";
import { useDrafts } from "../../../../hooks/use-compose.ts";
import { threadQuery } from "../../../../lib/mail-queries.ts";

export const Route = createFileRoute("/_authed/$workspace/mail/drafts/$threadId")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(threadQuery(params.threadId)),
  component: DraftThread,
});

function DraftThread() {
  const { threadId } = Route.useParams();
  const { mailbox } = Route.useSearch();
  const draft = useDrafts(mailbox).data?.find((d) => d.threadId === threadId);
  const { id, kind, sourceMessageId } = draft ?? {};
  useEffect(() => {
    if (!id) return;
    requestCompose({
      threadId,
      kind: kind === "forward" ? "forward" : "reply",
      messageId: sourceMessageId ?? undefined,
    });
  }, [threadId, id, kind, sourceMessageId]);
  return <Conversation threadId={threadId} />;
}
