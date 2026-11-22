import { useMemo } from "react";
import { IconMicrophone, IconRepeat } from "@/components/icons/central";
import { RecordMark } from "@/components/crm/record-list";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarSection } from "@/components/ui/sidebar";
import { useMeetingGroups } from "@/hooks/use-meetings.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { groupByDate } from "@/lib/date-groups.ts";
import { groupKind, groupTitle, meetingGroupPath, type MeetingGroup } from "@/lib/meetings.ts";

/** The groups of meetings, newest first, under the day or week they last met. */
export function MeetingsNav() {
  const { data: groups, isPending } = useMeetingGroups();
  const sections = useMemo(
    () => groupByDate(groups ?? [], (group) => group.lastStartedAt ?? new Date(0).toISOString()),
    [groups],
  );
  if (isPending) {
    return (
      <SidebarSection>
        <SidebarTreeBones depth={0} />
      </SidebarSection>
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
    </>
  );
}

function GroupRow({ group }: { group: MeetingGroup }) {
  const { place, href } = useWorkspacePaths();
  const path = meetingGroupPath(group.groupKey);
  const kind = groupKind(group.groupKey);
  const title = groupTitle(group);
  return (
    <SidebarTreeRow
      href={href(path)}
      isCurrent={place === path || place === `/meetings/g/${group.groupKey}`}
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
      detail={group.meetings > 1 ? group.meetings : undefined}
    />
  );
}
