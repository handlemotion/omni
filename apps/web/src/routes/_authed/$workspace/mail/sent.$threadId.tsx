import { createFileRoute } from "@tanstack/react-router";
import { threadQuery } from "../../../../lib/mail-queries.ts";
import { Conversation } from "../../../../components/conversation/conversation.tsx";

export const Route = createFileRoute("/_authed/$workspace/mail/sent/$threadId")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(threadQuery(params.threadId)),
  component: function SentMailThread() {
    return <Conversation threadId={Route.useParams().threadId} />;
  },
});
