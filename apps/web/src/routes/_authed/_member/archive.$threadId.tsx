import { createFileRoute } from "@tanstack/react-router";
import { threadQuery } from "../../../lib/mail-queries.ts";
import { ThreadView } from "../../-placeholders.tsx";

export const Route = createFileRoute("/_authed/_member/archive/$threadId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(threadQuery(params.threadId)),
  component: function ArchiveThread() {
    return <ThreadView threadId={Route.useParams().threadId} />;
  },
});
