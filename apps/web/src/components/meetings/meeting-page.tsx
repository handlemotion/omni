import { MeetingRecord } from "./meeting-record.tsx";
import { useState, type ComponentType, type ReactNode } from "react";
import { Skeleton } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import {
  IconArrowRotateClockwise,
  IconCalendar,
  IconCheck,
  IconChecklist,
  IconCircleAlert,
  IconClock3,
  IconCopy,
  IconEllipsis,
  IconGlobe,
  IconLink,
  IconList,
  IconPeople,
  IconSparkle,
  IconTrash,
} from "@/components/icons/central";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";
import { appToast } from "@/components/ui/toast";
import { useClipboard } from "@/hooks/use-clipboard.ts";
import { useMeeting, useMeetingWrites } from "@/hooks/use-meetings.ts";
import { ApiError } from "@/lib/api.ts";
import { groupKind, meetingClock, meetingGroupPath, type Meeting } from "@/lib/meetings.ts";
import { Link } from "@/components/ui/link";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { ActionItem } from "./meeting-actions.tsx";
import { MeetingAudio, PlayerRow, usePlayer } from "./meeting-player.tsx";
import { ShareMeetingDialog } from "./meeting-share.tsx";
import { MeetingTranscript } from "./meeting-transcript.tsx";

const WHEN = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const WORKING: Record<string, string> = {
  recording: "Recording",
  uploaded: "Transcribing",
  transcribing: "Transcribing",
  naming: "Naming speakers",
  writing: "Writing notes",
};

const LANGUAGES = new Intl.DisplayNames(undefined, { type: "language" });
const minutes = (ms: number | null) => (ms ? `${Math.max(1, Math.round(ms / 60_000))} min` : null);
const initial = (name: string) => name.trim().slice(0, 1).toUpperCase();

/** One recorded meeting: a page to read, with its recording, its notes and who said what. */
export function MeetingPage({ id }: { id: string }) {
  const meeting = useMeeting(id);
  const [sharing, setSharing] = useState(false);
  if (!meeting.data) return <MeetingState query={meeting} />;
  const data = meeting.data;
  const m = data.meeting;
  const editor = data.role !== "viewer";
  return (
    <StorageFrame
      title={<GroupCrumb meeting={data} />}
      actions={<HeaderActions meeting={data} onShare={() => setSharing(true)} />}
    >
      <MeetingAudio id={id} hasAudio={m.hasAudio} durationMs={m.durationMs}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 pt-10 pb-16">
            <header className="flex flex-col gap-3">
              <h1 className="text-2xl text-foreground">{m.title ?? "Untitled meeting"}</h1>
              <MetaRow meeting={data} />
            </header>
            <Properties
              meeting={data}
              onShare={editor ? () => setSharing(true) : undefined}
              canEdit={editor}
            />
            <Progress meeting={data} />
            <Tabs className="w-full">
              <TabList
                aria-label="Meeting"
                className="sticky top-0 z-10 bg-background pt-1.5 [--tab-list-pb:--spacing(1.5)]"
              >
                <Tab id="summary">Summary</Tab>
                <Tab id="transcript">Transcript</Tab>
              </TabList>
              <TabPanel id="summary" className="flex flex-col gap-8 pt-6">
                <Summary meeting={data} canDecide={editor} />
              </TabPanel>
              <TabPanel id="transcript" className="flex flex-col pt-6">
                {m.status === "ready" ? (
                  <MeetingTranscript meeting={data} canRename={editor} />
                ) : (
                  <Quiet>–</Quiet>
                )}
              </TabPanel>
            </Tabs>
          </article>
        </div>
      </MeetingAudio>
      {sharing && <ShareMeetingDialog meeting={data} onClose={() => setSharing(false)} />}
    </StorageFrame>
  );
}

function GroupCrumb({ meeting }: { meeting: Meeting }) {
  const { href } = useWorkspacePaths();
  const key = meeting.meeting.groupKey;
  const label =
    groupKind(key) === "domain"
      ? key.slice("domain:".length)
      : (meeting.meeting.title ?? "Meetings");
  return (
    <Link
      href={href(meetingGroupPath(key))}
      className="truncate text-md text-muted-foreground hover:text-foreground"
    >
      {label}
    </Link>
  );
}

function HeaderActions(props: { meeting: Meeting; onShare: () => void }) {
  const { copy, copied } = useClipboard();
  return (
    <>
      <Button
        intent="plain"
        size="sq-sm"
        aria-label={copied ? "Link copied" : "Copy link"}
        onPress={() => void copy(window.location.href)}
      >
        {copied ? <IconCheck /> : <IconLink />}
      </Button>
      {props.meeting.role !== "viewer" && (
        <Button size="sm" onPress={props.onShare}>
          Share
        </Button>
      )}
      <MoreMenu meeting={props.meeting} />
    </>
  );
}

function MetaRow({ meeting }: { meeting: Meeting }) {
  const m = meeting.meeting;
  const items: { icon: ComponentType<{ className?: string }>; label: string | null }[] = [
    { icon: IconCalendar, label: WHEN.format(new Date(m.startedAt)) },
    { icon: IconClock3, label: minutes(m.durationMs) },
    {
      icon: IconPeople,
      label: meeting.attendees.length ? `${meeting.attendees.length} people` : null,
    },
    { icon: IconGlobe, label: m.language ? (LANGUAGES.of(m.language) ?? null) : null },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
      {items
        .filter((item) => item.label)
        .map(({ icon: Icon, label }) => (
          <span key={label} className="flex items-center gap-1.5 tabular-nums">
            <Icon className="size-icon" />
            {label}
          </span>
        ))}
    </div>
  );
}

function Properties(props: {
  meeting: Meeting;
  onShare: (() => void) | undefined;
  canEdit: boolean;
}) {
  const player = usePlayer();
  const names = new Map(props.meeting.attendees.map((a) => [a.address, a.name]));
  const people = (props.meeting.sharing?.grants ?? []).map((g) => ({
    address: g.address,
    name: names.get(g.address) ?? null,
  }));
  const workspace = props.meeting.sharing?.access === "workspace";
  return (
    <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
      {player.hasAudio && (
        <Property label="Audio">
          <PlayerRow />
        </Property>
      )}
      {props.meeting.sharing && (
        <Property label="Shared with">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex -space-x-1">
              {people.slice(0, 5).map((person) => (
                <Avatar
                  key={person.address}
                  size="xs"
                  initials={initial(person.name ?? person.address)}
                  className="ring-2 ring-background"
                  title={person.name ?? person.address}
                />
              ))}
            </div>
            <span className="truncate text-muted-foreground">
              {[
                ...(workspace ? ["Everyone in the workspace"] : []),
                ...people.map((p) => (p.name ?? p.address).split(" ")[0]),
              ].join(", ")}
            </span>
            {props.onShare && (
              <Button intent="plain" size="sm" onPress={props.onShare} className="ms-auto">
                Manage
              </Button>
            )}
          </div>
        </Property>
      )}
      <MeetingRecord meeting={props.meeting} canEdit={props.canEdit} />
    </dl>
  );
}

function Property(props: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center">{props.children}</dd>
    </>
  );
}

function Progress({ meeting }: { meeting: Meeting }) {
  const { retry } = useMeetingWrites();
  const m = meeting.meeting;
  if (WORKING[m.status]) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-surface px-4 py-3.5">
        <Loader className="size-4 text-muted-foreground" />
        <span className="text-sm">{WORKING[m.status]}</span>
      </div>
    );
  }
  if (m.status !== "failed") return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-surface px-4 py-3.5">
      <IconCircleAlert className="size-icon shrink-0 text-danger" />
      <span className="min-w-0 flex-1 text-sm">{m.failure}</span>
      {meeting.role !== "viewer" && (
        <Button
          intent="outline"
          size="sm"
          isPending={retry.isPending}
          onPress={() =>
            retry.mutate(m.id, {
              onError: () => appToast.error("The meeting could not be retried"),
            })
          }
        >
          Try again
        </Button>
      )}
    </div>
  );
}

function Block(props: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <section className="flex flex-col gap-3" aria-label={props.title}>
      <div className="flex h-7 items-center gap-2">
        <Icon className="size-icon text-muted-foreground" />
        <h2 className="text-sm text-foreground">{props.title}</h2>
        {props.action && <div className="ms-auto">{props.action}</div>}
      </div>
      {props.children}
    </section>
  );
}

function Summary({ meeting, canDecide }: { meeting: Meeting; canDecide: boolean }) {
  const notes = meeting.notes;
  const { copy, copied } = useClipboard();
  const player = usePlayer();
  if (!notes?.summary && !meeting.actions.length) return <Quiet>–</Quiet>;
  const text = [
    notes?.summary,
    ...(notes?.highlights ?? []).map((h) => `[${meetingClock(h.atMs)}] ${h.text}`),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      {notes?.summary && (
        <Block
          icon={IconSparkle}
          title="Overview"
          action={
            <Button intent="plain" size="sm" onPress={() => void copy(text)}>
              {copied ? <IconCheck data-slot="icon" /> : <IconCopy data-slot="icon" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          }
        >
          <p className="text-sm/6 text-foreground">{notes.summary}</p>
          {notes.topics.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {notes.topics.map((topic) => (
                <Badge key={topic} intent="secondary">
                  {topic}
                </Badge>
              ))}
            </div>
          )}
        </Block>
      )}
      {meeting.actions.length > 0 && (
        <Block icon={IconChecklist} title="Action items">
          <ul className="flex flex-col">
            {meeting.actions.map((action) => (
              <ActionItem key={action.id} action={action} canDecide={canDecide} />
            ))}
          </ul>
        </Block>
      )}
      {notes && notes.highlights.length > 0 && (
        <Block icon={IconList} title="Highlights">
          <ul className="flex flex-col">
            {notes.highlights.map((h) => (
              <li key={`${h.atMs}:${h.text}`} className="flex items-center gap-3 py-1">
                <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm/6">{h.text}</span>
                {player.hasAudio ? (
                  <Button
                    intent="plain"
                    size="sm"
                    aria-label={`Play from ${meetingClock(h.atMs)}`}
                    onPress={() => player.seek(h.atMs)}
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                  >
                    {meetingClock(h.atMs)}
                  </Button>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {meetingClock(h.atMs)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}

function MoreMenu({ meeting }: { meeting: Meeting }) {
  const { retry, remove } = useMeetingWrites();
  const id = meeting.meeting.id;
  const failed = meeting.meeting.status === "failed";
  const owner = meeting.role === "owner";
  if (!owner && !(failed && meeting.role !== "viewer")) return null;
  return (
    <MenuTrigger>
      <Button intent="plain" size="sq-sm" aria-label="More">
        <IconEllipsis />
      </Button>
      <Menu
        placement="bottom end"
        aria-label="Meeting"
        onAction={(key) => {
          if (key === "retry") retry.mutate(id);
          if (key === "delete") {
            remove.mutate(id, { onError: () => appToast.error("The meeting was not deleted") });
          }
        }}
      >
        {failed && (
          <MenuItem id="retry" textValue="Try again">
            <IconArrowRotateClockwise data-slot="icon" />
            <MenuLabel>Try again</MenuLabel>
          </MenuItem>
        )}
        {owner && (
          <MenuItem id="delete" textValue="Delete meeting" intent="danger">
            <IconTrash data-slot="icon" />
            <MenuLabel>Delete meeting</MenuLabel>
          </MenuItem>
        )}
      </Menu>
    </MenuTrigger>
  );
}

function Quiet(props: { children: ReactNode }) {
  return (
    <span className="flex h-8 items-center text-sm text-muted-foreground">{props.children}</span>
  );
}

function MeetingState(props: { query: { isPending: boolean; error: unknown } }) {
  const gone = props.query.error instanceof ApiError && props.query.error.status === 404;
  return (
    <StorageFrame title={null}>
      {props.query.isPending ? (
        <Skeleton loading label="Loading">
          {null}
        </Skeleton>
      ) : (
        <EmptyState
          figure="loupe"
          title={gone ? "This meeting is gone" : "This meeting could not be loaded"}
        />
      )}
    </StorageFrame>
  );
}
