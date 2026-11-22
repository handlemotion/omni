import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { FieldRow } from "@/components/crm/record-fields.tsx";
import { IconMicrophone, IconNote } from "@/components/icons/central";
import { useOptionalStorageHref } from "@/components/storage/file-list";
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { appToast } from "@/components/ui/toast";
import {
  useEventMeetings,
  useMeeting,
  useMeetingsEnabled,
  useTaskMeeting,
} from "@/hooks/use-meetings.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import type { CalendarEvent } from "@/lib/calendar.ts";
import { meetingPath } from "@/lib/meetings.ts";
import { driveOf } from "@/lib/storage.ts";
import { storageNodeQuery } from "@/lib/storage-comments.ts";

/** Opens a Drive file where it lives now, in its folder's list with its panel open. */
export function useOpenFile() {
  const client = useQueryClient();
  const storageHref = useOptionalStorageHref();
  const router = useRouter();
  return useMutation({
    meta: { handlesError: true },
    mutationFn: async (nodeId: string) => {
      const { node } = await client.fetchQuery(storageNodeQuery(nodeId));
      if (!storageHref) return;
      const folder = storageHref(driveOf(node), node.parentId ?? undefined);
      const file = `file=${encodeURIComponent(node.id)}`;
      await router.navigate({ href: `${folder}${folder.includes("?") ? "&" : "?"}${file}` });
    },
    onError: () => appToast.error("The notes could not be opened"),
  });
}

/**
 * A calendar meeting's recordings beside the event: each part's summary, a link to its meeting
 * page, and its notes doc where it has one. Nothing while Meetings is off or it was not recorded.
 */
export function EventRecording({ event }: { event: CalendarEvent }) {
  const enabled = useMeetingsEnabled();
  const { data: meetings } = useEventMeetings(
    { uid: event.uid, recurrenceId: event.recurrenceId },
    enabled,
  );
  if (!meetings?.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {meetings.map((meeting) => (
        <RecordedPart
          key={meeting.id}
          id={meeting.id}
          label={meetings.length > 1 ? `Recording ${meeting.part}` : "Recording"}
          notesNodeId={meeting.notesNodeId}
        />
      ))}
    </div>
  );
}

function RecordedPart(props: { id: string; label: string; notesNodeId: string | null }) {
  const { href } = useWorkspacePaths();
  const summary = useMeeting(props.id).data?.notes?.summary;
  const open = useOpenFile();
  const notesNodeId = props.notesNodeId;
  return (
    <div className="flex flex-col gap-2">
      {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Link
          href={href(meetingPath(props.id))}
          className={buttonStyles({ intent: "secondary", size: "sm" })}
        >
          <IconMicrophone />
          {props.label}
        </Link>
        {notesNodeId && (
          <Button
            size="sm"
            intent="outline"
            isPending={open.isPending}
            onPress={() => open.mutate(notesNodeId)}
          >
            <IconNote />
            Notes
          </Button>
        )}
      </div>
    </div>
  );
}

/** The meeting a task was accepted from, as a link to its page; nothing when there is none. */
export function TaskMeeting({ taskId }: { taskId: string }) {
  const enabled = useMeetingsEnabled();
  const { data } = useTaskMeeting(taskId, enabled);
  const { href } = useWorkspacePaths();
  if (!data) return null;
  return (
    <FieldRow label="Meeting">
      <span className="flex min-w-0 flex-1 items-center px-2">
        <Link
          href={href(meetingPath(data.meeting.id))}
          className="truncate text-sm text-foreground underline-offset-2 hover:underline"
        >
          {data.meeting.title ?? "Untitled meeting"}
        </Link>
      </span>
    </FieldRow>
  );
}
