import { createFileRoute } from "@tanstack/react-router";
import { threadQuery } from "../../../lib/mail-queries.ts";
import { ThreadView } from "../../-placeholders.tsx";

export const Route = createFileRoute("/_authed/_member/search/$threadId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(threadQuery(params.threadId)),
  component: function SearchThread() {
    return <ThreadView threadId={Route.useParams().threadId} />;
  },
});
