import { createFileRoute, Outlet } from "@tanstack/react-router";
import { meetingGroupsQuery } from "../../../lib/meetings.ts";

export const Route = createFileRoute("/_authed/$workspace/meetings")({
  loader: ({ context }) => {
    void context.queryClient.prefetchInfiniteQuery(meetingGroupsQuery());
  },
  component: Outlet,
});
