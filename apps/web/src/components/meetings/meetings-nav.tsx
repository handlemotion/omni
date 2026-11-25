import { useMemo, useState } from "react";
import { IconMicrophone, IconRepeat } from "@/components/icons/central";
import { RecordMark } from "@/components/crm/record-list";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarSection } from "@/components/ui/sidebar";
import { useMeetingGroups, useMeetingList, usePrefetchMeetingPlace } from "@/hooks/use-meetings.ts";
import { Button } from "@/components/ui/button";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { groupByDate } from "@/lib/date-groups.ts";
import { DAY } from "@/lib/dates.ts";
import {
  groupKind,
  groupTarget,
  groupTitle,
  meetingPath,
  type MeetingGroup,
} from "@/lib/meetings.ts";

/** The groups of meetings, newest first, under the day or week they last met. */
export function MeetingsNav() {
  const {
    data: groups,
    isPending,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useMeetingGroups();
  const sections = useMemo(
    () => groupByDate(groups ?? [], (group) => group.lastStartedAt ?? new Date(0).toISOString()),
    [groups],
  );
  if (isPending) {
    return (
      <>
        <SidebarSection>
          <SidebarTreeBones depth={0} />
        </SidebarSection>
      </>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <SidebarSection key={section.id} label={section.label}>
          {section.rows.map((group) => (
            <GroupRow key={group.groupKey} group={group} />
          ))}
        </SidebarSection>
      ))}
      {hasNextPage && (
        <div className="px-2 pb-2">
          <Button
            intent="plain"
            size="sm"
            isPending={isFetchingNextPage}
            onPress={() => void fetchNextPage()}
          >
            Show older
          </Button>
        </div>
      )}
    </>
  );
}

function GroupRow({ group }: { group: MeetingGroup }) {
  const { place, href } = useWorkspacePaths();
  const prefetch = usePrefetchMeetingPlace();
  const [open, setOpen] = useState(false);
  const path = groupTarget(group.groupKey);
  const kind = groupKind(group.groupKey);
  const title = groupTitle(group);
  const many = kind !== "meeting";
  return (
    <>
      <SidebarTreeRow
        href={href(path)}
        isCurrent={place === path}
        depth={0}
        icon={
          kind === "domain" ? (
            <RecordMark name={title} square size={16} who={{ domain: title }} />
          ) : kind === "series" ? (
            <IconRepeat className="size-icon" />
          ) : (
            <IconMicrophone className="size-icon" />
          )
        }
        label={title}
        detail={many && group.meetings > 1 ? group.meetings : undefined}
        expand={many ? { value: open, toggle: () => setOpen(!open) } : undefined}
        onIntent={() =>
          prefetch(
            many
              ? { groupKey: group.groupKey }
              : { meetingId: group.groupKey.slice("meeting:".length) },
          )
        }
      />
      {open && <GroupMeetings groupKey={group.groupKey} />}
    </>
  );
}

function GroupMeetings({ groupKey }: { groupKey: string }) {
  const { place, href } = useWorkspacePaths();
  const prefetch = usePrefetchMeetingPlace();
  const list = useMeetingList(groupKey);
  if (list.isPending) return <SidebarTreeBones depth={1} />;
  return (
    <>
      {list.data?.map((meeting) => {
        const path = meetingPath(meeting.id);
        return (
          <SidebarTreeRow
            key={meeting.id}
            href={href(path)}
            isCurrent={place === path}
            depth={1}
            icon={<IconMicrophone className="size-icon" />}
            label={meeting.title ?? DAY.format(new Date(meeting.startedAt))}
            detail={meeting.title ? DAY.format(new Date(meeting.startedAt)) : undefined}
            onIntent={() => prefetch({ meetingId: meeting.id })}
          />
        );
      })}
      {list.hasNextPage && (
        <div style={{ paddingInlineStart: 24 }}>
          <Button
            intent="plain"
            size="sm"
            isPending={list.isFetchingNextPage}
            onPress={() => void list.fetchNextPage()}
          >
            Show older
          </Button>
        </div>
      )}
    </>
  );
}
