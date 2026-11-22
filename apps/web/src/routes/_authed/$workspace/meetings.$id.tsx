import { createFileRoute } from "@tanstack/react-router";
import { MeetingPage } from "../../../components/meetings/meeting-page.tsx";
import { meetingQuery, meetingTranscriptQuery } from "../../../lib/meetings.ts";

export const Route = createFileRoute("/_authed/$workspace/meetings/$id")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(meetingQuery(params.id));
    void context.queryClient.prefetchQuery(meetingTranscriptQuery(params.id));
  },
  component: Meeting,
});

function Meeting() {
  const { id } = Route.useParams();
  return <MeetingPage key={id} id={id} />;
}
