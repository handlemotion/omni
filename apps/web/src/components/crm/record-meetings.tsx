import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconX } from "@/components/icons/central";
import { SettingsRowMenu } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { dealMeetingsQuery, placeMeetingMutation, type CrmMeeting } from "@/lib/crm-meetings.ts";
import { meetingPath } from "@/lib/meetings.ts";
import { crmErrorToast } from "./crm-errors.ts";

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** `42 min`, or `1 h 5 min`: how long a meeting lasted. */
export function lasted(ms: number | null) {
  if (!ms) return null;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

/** What a meeting row says under its title: when, how long, and its open actions. */
export function meetingMeta(meeting: Pick<CrmMeeting, "startedAt" | "durationMs" | "openActions">) {
  return [
    DAY.format(new Date(meeting.startedAt)),
    lasted(meeting.durationMs),
    meeting.openActions
      ? `${meeting.openActions} open ${meeting.openActions === 1 ? "action" : "actions"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A project's Meetings tab: its recorded meetings, newest first, each opening its page. */
export function DealMeetings({ dealId }: { dealId: string }) {
  const list = useInfiniteQuery(dealMeetingsQuery(dealId));
  if (list.isPending) {
    return (
      <Skeleton loading label="Loading meetings">
        {null}
      </Skeleton>
    );
  }
  if (list.isError) {
    return (
      <Button size="sm" intent="outline" className="self-start" onPress={() => void list.refetch()}>
        Try again
      </Button>
    );
  }
  if (list.data.length === 0) return <EmptyState figure="cabinet" title="No meetings yet" />;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-background">
        {list.data.map((meeting) => (
          <MeetingRow key={meeting.id} dealId={dealId} meeting={meeting} />
        ))}
      </ul>
      {list.hasNextPage && (
        <Button
          size="sm"
          intent="outline"
          className="self-start"
          isPending={list.isFetchingNextPage}
          onPress={() => void list.fetchNextPage()}
        >
          Show more
        </Button>
      )}
    </div>
  );
}

function MeetingRow(props: { dealId: string; meeting: CrmMeeting }) {
  const { meeting } = props;
  const { href } = useWorkspacePaths();
  const place = useMutation(placeMeetingMutation(useQueryClient()));
  return (
    <li className="flex items-start gap-2 px-3 py-2.5">
      <Link href={href(meetingPath(meeting.id))} className="flex min-w-0 flex-1 flex-col gap-y-1">
        <span className="truncate text-sm">{meeting.title ?? "Untitled meeting"}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{meetingMeta(meeting)}</span>
        {meeting.summary && (
          <span className="line-clamp-2 text-sm text-muted-foreground">{meeting.summary}</span>
        )}
      </Link>
      <span className="-my-[3px] shrink-0">
        <SettingsRowMenu
          label={`Actions for ${meeting.title ?? "this meeting"}`}
          items={[
            {
              icon: IconX,
              label: "Take off this project",
              onAction: () =>
                place.mutate(
                  { records: "deals", id: props.dealId, meetingId: meeting.id, action: "remove" },
                  { onError: (error) => crmErrorToast(error, "The meeting was not taken off") },
                ),
            },
          ]}
        />
      </span>
    </li>
  );
}

/** A meeting in a record's timeline: when and how long, its summary, opening its page. */
export function MeetingLine({ meeting }: { meeting: CrmMeeting }) {
  const { href } = useWorkspacePaths();
  return (
    <Link href={href(meetingPath(meeting.id))} className="flex min-w-0 flex-col gap-y-1">
      <span className="text-xs text-muted-foreground tabular-nums">{meetingMeta(meeting)}</span>
      {meeting.summary && <span className="line-clamp-3 text-sm">{meeting.summary}</span>}
    </Link>
  );
}
