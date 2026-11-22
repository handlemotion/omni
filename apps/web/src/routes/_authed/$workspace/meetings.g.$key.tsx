import { createFileRoute } from "@tanstack/react-router";
import { GroupPage } from "../../../components/meetings/group-page.tsx";
import { meetingGroupQuery } from "../../../lib/meetings.ts";

export const Route = createFileRoute("/_authed/$workspace/meetings/g/$key")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(meetingGroupQuery(params.key));
  },
  component: Group,
});

function Group() {
  const { key } = Route.useParams();
  return <GroupPage key={key} groupKey={key} />;
}
