import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createDraft } from "@/lib/compose.ts";
import { keys } from "@/lib/query-keys.ts";
import { useAllMailboxes } from "./use-mail.ts";
import { useCurrentWorkspace, useWorkspaceSlug } from "./use-workspaces.ts";
import {
  changeMeetingMutation,
  decideActionMutation,
  deleteMeetingMutation,
  eventMeetingsQuery,
  taskMeetingQuery,
  grantMeetingMutation,
  meetingGroupQuery,
  meetingGroupsQuery,
  meetingListQuery,
  meetingQuery,
  meetingsEnabledQuery,
  meetingTranscriptQuery,
  renameSpeakerMutation,
  retryMeetingMutation,
  revokeMeetingMutation,
} from "@/lib/meetings.ts";

export const useMeetingsEnabled = () => useQuery(meetingsEnabledQuery()).data === true;
export const useMeetingGroups = () => useInfiniteQuery(meetingGroupsQuery());
export const useMeetingGroup = (key: string) => useQuery(meetingGroupQuery(key));
export const useMeetingList = (group: string) => useInfiniteQuery(meetingListQuery(group));
export const useMeeting = (id: string) => useQuery(meetingQuery(id));
export const useMeetingTranscript = (id: string) => useQuery(meetingTranscriptQuery(id));
export const useEventMeetings = (
  event: { uid: string; recurrenceId: string | null },
  enabled = true,
) => useQuery({ ...eventMeetingsQuery(event), enabled });
export const useTaskMeeting = (taskId: string, enabled = true) =>
  useQuery({ ...taskMeetingQuery(taskId), enabled });

/** Every write on a meeting, each refreshing what it changed when it settles. */
export function useMeetingWrites() {
  const client = useQueryClient();
  return {
    renameSpeaker: useMutation(renameSpeakerMutation(client)),
    decideAction: useMutation(decideActionMutation(client)),
    change: useMutation(changeMeetingMutation(client)),
    grant: useMutation(grantMeetingMutation(client)),
    revoke: useMutation(revokeMeetingMutation(client)),
    retry: useMutation(retryMeetingMutation(client)),
    remove: useMutation(deleteMeetingMutation(client)),
  };
}

/**
 * A meeting's follow-up email, as a draft in the person's own mailbox in this workspace, opened in
 * Drafts to read, change and send. The action is accepted before the page leaves, so it is not
 * offered again. Nothing is sent from here.
 */
export function useMeetingDraft() {
  const client = useQueryClient();
  const { data: mailboxes } = useAllMailboxes();
  const orgId = useCurrentWorkspace()?.id;
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const decide = useMutation(decideActionMutation(client));
  return useMutation({
    mutationFn: async (input: {
      actionId: string;
      email: { to: string[]; subject: string; body: string };
    }) => {
      const usable = (mailboxes ?? []).filter((m) => m.orgId === orgId && m.status === "active");
      const mailbox = usable.find((m) => m.kind === "personal" && m.role === "owner") ?? usable[0];
      if (!mailbox) throw new Error("no mailbox to write from");
      const draft = await createDraft({
        mailboxId: mailbox.id,
        kind: "new",
        to: input.email.to.map((address) => ({ name: null, address })),
        subject: input.email.subject,
        bodyText: input.email.body,
      });
      await decide.mutateAsync({ id: input.actionId, accept: true });
      await client.invalidateQueries({ queryKey: keys.draftLists() });
      await navigate({
        to: "/$workspace/mail/drafts",
        params: { workspace },
        search: { mailbox: mailbox.id, draft: draft.id },
      });
    },
  });
}
