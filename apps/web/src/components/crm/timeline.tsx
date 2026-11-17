import { useState, type ComponentType, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import {
  IconCircle,
  IconFileText,
  IconMail,
  IconNote,
  IconTrash,
} from "@/components/icons/central";
import { SettingsRowMenu } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Textarea } from "@/components/ui/textarea";
import { useCreateNote, useCrmStages, useCrmTimeline, useDeleteNote } from "@/hooks/use-crm.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { useMember } from "@/hooks/use-session.ts";
import type { CrmRecordKind, CrmStage, CrmTimelineItem } from "@/lib/crm.ts";
import { crmErrorToast } from "./crm-errors.ts";

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const CONTRACT_STATUS = {
  draft: "moved back to draft",
  sent: "sent",
  signed: "signed",
  ended: "ended",
};

export function Timeline({ kind, id }: { kind: CrmRecordKind; id: string }) {
  const timeline = useCrmTimeline(kind, id);
  const names = useMemberNames();
  const stages = useCrmStages().data ?? [];
  return (
    <div className="flex flex-col gap-6">
      <NoteComposer kind={kind} id={id} />
      {timeline.isPending ? (
        <Skeleton loading label="Loading the timeline" skeleton={<TimelineBones />}>
          {null}
        </Skeleton>
      ) : timeline.isError ? (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>The timeline didn't load</span>
          <Button size="sm" intent="outline" onPress={() => void timeline.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ol className="flex flex-col gap-5" aria-label="Timeline">
          {timeline.items.map((item) => (
            <Item key={`${item.kind}:${item.id}`} item={item} names={names} stages={stages} />
          ))}
        </ol>
      )}
      {timeline.hasNextPage && (
        <Button
          size="sm"
          intent="outline"
          className="self-start"
          isPending={timeline.isFetchingNextPage}
          onPress={() => void timeline.fetchNextPage()}
        >
          Show older
        </Button>
      )}
    </div>
  );
}

function useMemberNames() {
  const members = useMembers().data?.members ?? [];
  return new Map(members.map((m) => [m.id, m.user.name || m.user.email]));
}

type Names = Map<string, string>;

function Item(props: { item: CrmTimelineItem; names: Names; stages: CrmStage[] }) {
  const { item, names } = props;
  const who = (id: string | null) => (id ? (names.get(id) ?? "A former member") : "Someone");
  switch (item.kind) {
    case "note":
      return (
        <Line icon={IconNote} at={item.at} text={<Actor name={who(item.note.authorMemberId)} />}>
          <NoteCard noteId={item.note.id} body={item.note.body} author={item.note.authorMemberId} />
        </Line>
      );
    case "thread":
      return (
        <Line
          icon={IconMail}
          at={item.at}
          text={
            <>
              <Actor
                name={item.thread.latestFrom?.name || item.thread.latestFrom?.address || "Mail"}
              />{" "}
              <span className="text-muted-foreground">wrote</span>
            </>
          }
        >
          <Card>
            <Link href={appPath(item.thread.url)} className="block min-w-0">
              <span className="block truncate text-sm">
                {item.thread.subject || "(no subject)"}
              </span>
              <span className="block truncate text-xs/4 text-muted-foreground">
                {item.thread.snippet}
              </span>
            </Link>
          </Card>
        </Line>
      );
    case "activity":
      return (
        <Line
          icon={IconMail}
          at={item.at}
          text={
            <>
              <Actor name={item.activity.mailbox.name} />{" "}
              <span className="text-muted-foreground">
                {item.activity.direction === "out" ? "wrote to them" : "heard from them"}
              </span>
              {item.activity.subject && <span> · {item.activity.subject}</span>}
            </>
          }
        />
      );
    case "contract":
      return (
        <Line
          icon={IconFileText}
          at={item.at}
          text={
            <>
              <Actor name={who(item.contract.actorMemberId)} />{" "}
              <span className="text-muted-foreground">{contractVerb(item.contract)}</span>{" "}
              <span>{item.contract.title}</span>
            </>
          }
        />
      );
    case "event": {
      const said = eventText(item.event, props.stages);
      if (!said) return null;
      return (
        <Line
          icon={IconCircle}
          at={item.at}
          text={
            <>
              <Actor name={who(item.event.actorMemberId)} />{" "}
              <span className="text-muted-foreground">{said}</span>
            </>
          }
        />
      );
    }
  }
}

type EventItem = Extract<CrmTimelineItem, { kind: "event" }>["event"];

function eventText(event: EventItem, stages: CrmStage[]) {
  const data = event.data as Record<string, unknown>;
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : "");
  switch (event.kind) {
    case "created":
      return "created this";
    case "updated":
      return "edited the details";
    case "archived":
      return "archived this";
    case "stage_moved": {
      const stage = stages.find((s) => s.id === text("to"));
      return stage ? `moved it to ${stage.name}` : "moved its stage";
    }
    case "owner_changed":
      return "changed the owner";
    case "value_changed":
      return "changed the value";
    case "people_set":
      return "changed the people";
    case "domain_added":
      return `added ${text("domain")}`;
    case "domain_removed":
      return `removed ${text("domain")}`;
    case "address_added":
      return `added ${text("address")}`;
    case "address_removed":
      return `removed ${text("address")}`;
    default:
      return null;
  }
}

function contractVerb(contract: Extract<CrmTimelineItem, { kind: "contract" }>["contract"]) {
  switch (contract.change) {
    case "created":
      return "drafted";
    case "status":
      return CONTRACT_STATUS[contract.status];
    case "document":
      return "replaced the file of";
    case "deleted":
      return "deleted";
  }
}

function appPath(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin ? parsed.pathname + parsed.search : url;
  } catch {
    return url;
  }
}

function Actor({ name }: { name: string }) {
  return <span className="text-foreground">{name}</span>;
}

function Line(props: {
  icon: ComponentType<{ className?: string }>;
  at: string;
  text: ReactNode;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <li className="flex flex-col gap-2">
      <div className="flex min-h-5 items-center gap-2 text-sm">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
          <Icon className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate">{props.text}</span>
        <time dateTime={props.at} className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {WHEN.format(new Date(props.at))}
        </time>
      </div>
      {props.children && <div className="ps-7">{props.children}</div>}
    </li>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2.5 shadow-(--shadow-raised)">
      {children}
    </div>
  );
}

function NoteCard(props: { noteId: string; body: string; author: string | null }) {
  const { member } = useMember();
  const remove = useDeleteNote();
  return (
    <Card>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm/5 break-words whitespace-pre-wrap">{props.body}</p>
        {props.author === member.id && (
          <span className="-my-[3px] shrink-0">
            <SettingsRowMenu
              label="Actions for this note"
              items={[
                {
                  icon: IconTrash,
                  label: "Delete note",
                  danger: true,
                  onAction: () =>
                    remove.mutate(props.noteId, {
                      onError: (error) => crmErrorToast(error, "The note was not deleted"),
                    }),
                },
              ]}
            />
          </span>
        )}
      </div>
    </Card>
  );
}

function NoteComposer({ kind, id }: { kind: CrmRecordKind; id: string }) {
  const create = useCreateNote();
  const [body, setBody] = useState("");
  const submit = () => {
    const text = body.trim();
    if (!text) return;
    create.mutate(
      { record: kind, id, body: text },
      {
        onSuccess: () => setBody(""),
        onError: (error) => crmErrorToast(error, "The note was not added"),
      },
    );
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border bg-background p-3 shadow-(--shadow-raised)"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        plain
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label="Note"
        maxLength={20_000}
        placeholder="Write a note…"
        className="max-h-60 min-h-10"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
      />
      <Button
        type="submit"
        size="sm"
        className="self-end"
        isDisabled={!body.trim()}
        isPending={create.isPending}
      >
        Add note
      </Button>
    </form>
  );
}

function TimelineBones() {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <SkeletonBox width={20} height={20} radius="999px" />
          <SkeletonBox width={`${30 + ((i * 13) % 35)}%`} height={10} />
        </div>
      ))}
    </div>
  );
}
