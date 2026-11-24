import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { StorageFrame } from "@/components/storage/storage-frame";
import { useMeetingGroup, useMeetingGroups, useMeetingList } from "@/hooks/use-meetings.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { groupTarget, groupTitle } from "@/lib/meetings.ts";
import { DAY } from "@/lib/dates.ts";

/** A series or a client's meetings as one page: where things stand, and what was decided when. */
export function GroupPage({ groupKey }: { groupKey: string }) {
  const page = useMeetingGroup(groupKey);
  const list = useMeetingList(groupKey);
  const title = list.data ? groupTitle({ groupKey, lastTitle: list.data[0]?.title ?? null }) : null;
  return (
    <StorageFrame title={<h1 className="truncate text-md">{title}</h1>}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Skeleton loading={page.isPending || list.isPending} label="Loading">
          {list.data && list.data.length === 0 ? (
            <EmptyState figure="cabinet" title="No meetings yet" />
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-6">
              {page.data?.summary && <p className="text-sm">{page.data.summary}</p>}
              {page.data && page.data.timeline.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-xs text-muted-foreground">Timeline</h2>
                  {page.data.timeline.map((item) => (
                    <div
                      key={`${item.meetingId}:${item.atMs}:${item.text}`}
                      className="flex items-baseline gap-3"
                    >
                      <p className="min-w-0 flex-1 text-sm">{item.text}</p>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {DAY.format(new Date(item.startedAt))}
                      </span>
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}
        </Skeleton>
      </div>
    </StorageFrame>
  );
}

/** The module's home: the sidebar is the index, so it opens the newest meeting or group. */
export function MeetingsHome() {
  const groups = useMeetingGroups();
  const { href } = useWorkspacePaths();
  const navigate = useNavigate();
  const first = groups.data?.[0]?.groupKey;
  useEffect(() => {
    if (first) void navigate({ href: href(groupTarget(first)), replace: true });
  }, [first, href, navigate]);
  if (first) return null;
  return (
    <StorageFrame title={<h1 className="truncate text-md">Meetings</h1>}>
      {!groups.isPending && <EmptyState figure="cabinet" title="No meetings yet" />}
    </StorageFrame>
  );
}
