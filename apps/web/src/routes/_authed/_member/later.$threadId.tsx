import { createFileRoute } from "@tanstack/react-router";
import { threadQuery } from "../../../lib/mail-queries.ts";
import { Conversation } from "../../../components/conversation/conversation.tsx";

export const Route = createFileRoute("/_authed/_member/later/$threadId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(threadQuery(params.threadId)),
  component: function LaterThread() {
    return <Conversation threadId={Route.useParams().threadId} />;
  },
});
