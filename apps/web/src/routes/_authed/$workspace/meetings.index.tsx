import { createFileRoute, redirect } from "@tanstack/react-router";
import { MeetingsHome } from "../../../components/meetings/group-page.tsx";
import { groupTarget, meetingGroupsQuery } from "../../../lib/meetings.ts";
import { startingUp } from "../../../lib/startup-fetch.ts";
import { workspaceHref } from "../../../lib/workspaces.ts";

/**
 * The module's home opens the newest meeting or group. Its groups known (or the app still
 * loading, behind its loading screen), it goes there before drawing anything; else the home
 * draws at once and goes when they come.
 */
export const Route = createFileRoute("/_authed/$workspace/meetings/")({
  loader: async ({ context, params, preload }) => {
    const client = context.queryClient;
    const known = client.getQueryData(meetingGroupsQuery().queryKey);
    if (preload || (!known && !startingUp())) return;
    const groups = known ?? (await client.ensureInfiniteQueryData(meetingGroupsQuery()));
    const first = groups.pages[0]?.groups[0];
    if (!first) return;
    throw redirect({
      href: workspaceHref(params.workspace, groupTarget(first.groupKey)),
      replace: true,
    });
  },
  component: MeetingsHome,
});
