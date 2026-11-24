import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RecordButton } from "../../../components/meetings/recorder.tsx";
import { meetingGroupsQuery } from "../../../lib/meetings.ts";

export const Route = createFileRoute("/_authed/$workspace/meetings")({
  loader: ({ context }) => {
    void context.queryClient.prefetchInfiniteQuery(meetingGroupsQuery());
  },
  component: Meetings,
});

function Meetings() {
  return (
    <>
      <Outlet />
      <RecordButton />
    </>
  );
}
