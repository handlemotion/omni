import { createFileRoute } from "@tanstack/react-router";
import { threadQuery } from "../../../../lib/mail-queries.ts";
import { Conversation } from "../../../../components/conversation/conversation.tsx";

export const Route = createFileRoute("/_authed/$workspace/mail/all/$threadId")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(threadQuery(params.threadId)),
  component: function AllMailThread() {
    return <Conversation threadId={Route.useParams().threadId} />;
  },
});
