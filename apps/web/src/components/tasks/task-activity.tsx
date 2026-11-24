import { dayOf, type CrmTask } from "@omni/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { IconCalendar, IconLink, IconUserRound } from "@/components/icons/central";
import { MemberAvatar, NoMemberAvatar } from "@/components/crm/member-avatar.tsx";
import { crmErrorToast } from "@/components/crm/crm-errors.ts";
import { NoteBox } from "@/components/crm/note-box.tsx";
import { useMemberNames } from "@/components/crm/task-dialog.tsx";
import { useMember } from "@/hooks/use-session.ts";
import { ago, DAY_YEAR } from "@/lib/dates.ts";
import {
  commentOnTaskMutation,
  taskActivityQuery,
  type TaskActivityItem,
  type TaskSource,
} from "@/lib/task-activity.ts";
import { PRIORITIES, STATUSES, StatusIcon } from "./task-fields.tsx";

const COMMENT_MAX = 10_000;

type Person = { id: string; name: string; image: string | null };

/**
 * What happened to the task, oldest first: its making, each change and who made it, and comments,
 * with a line to add one.
 */
export function TaskActivity(props: { task: CrmTask; source: TaskSource }) {
  const { task, source } = props;
  const query = useQuery(taskActivityQuery(source, task.id));
  const people = useMemberNames();
  const person = (id: string | null) => people.find((p) => p.id === id) ?? null;
  return (
    <section aria-label="Activity" className="flex flex-col gap-3">
      <h3 className="flex h-7 items-center text-sm font-medium text-foreground">Activity</h3>
      <Skeleton loading={query.isPending} label="Loading activity" skeleton={<ActivityBones />}>
        <ol className="relative flex flex-col gap-3">
          <span aria-hidden className="absolute start-1.75 top-2 bottom-2 w-px bg-border" />
          <Item
            mark={<Avatar person={person(task.createdByMemberId)} />}
            actor={person(task.createdByMemberId)}
            at={task.createdAt}
          >
            created the task
          </Item>
          {(query.data ?? []).map((item) => (
            <ActivityRow key={item.id} item={item} person={person} />
          ))}
        </ol>
      </Skeleton>
      <Composer task={task} source={source} />
    </section>
  );
}

function ActivityRow(props: {
  item: TaskActivityItem;
  person: (id: string | null) => Person | null;
}) {
  const { item, person } = props;
  const actor = person(item.actorMemberId);
  if (item.kind === "comment") {
    return (
      <Item mark={<Avatar person={actor} />} actor={actor} at={item.at} body={item.body}>
        commented
      </Item>
    );
  }
  const change = describe(item, person);
  return (
    <Item mark={change.mark} actor={actor} at={item.at}>
      {change.text}
    </Item>
  );
}

const Value = (props: { children: ReactNode }) => (
  <span className="font-medium text-foreground">{props.children}</span>
);

const dayText = (iso: string) => DAY_YEAR.format(new Date(`${dayOf(iso)}T00:00`));

function describe(
  item: Exclude<TaskActivityItem, { kind: "comment" }>,
  person: (id: string | null) => Person | null,
) {
  switch (item.kind) {
    case "status":
      return {
        mark: <StatusIcon status={item.to} />,
        text: (
          <>
            moved from <Value>{STATUSES[item.from].label}</Value> to{" "}
            <Value>{STATUSES[item.to].label}</Value>
          </>
        ),
      };
    case "priority": {
      const Icon = PRIORITIES[item.to ?? "none"].icon;
      return {
        mark: <Icon className="size-3.5 text-muted-foreground" />,
        text: item.to ? (
          <>
            set Priority to <Value>{PRIORITIES[item.to].label}</Value>
          </>
        ) : (
          "removed the priority"
        ),
      };
    }
    case "assignee": {
      const to = person(item.to);
      const from = person(item.from);
      return {
        mark: <IconUserRound className="size-3.5 text-muted-foreground" />,
        text: to ? (
          <>
            assigned <InlinePerson person={to} />
          </>
        ) : (
          <>unassigned {from ? <InlinePerson person={from} /> : "the task"}</>
        ),
      };
    }
    case "due":
      return {
        mark: <IconCalendar className="size-3.5 text-muted-foreground" />,
        text: item.to ? (
          <>
            set Due date to <Value>{dayText(item.to)}</Value>
          </>
        ) : (
          "cleared the due date"
        ),
      };
    case "record":
      return { mark: <IconLink className="size-3.5 text-muted-foreground" />, text: moved(item) };
  }
}

function moved(item: Extract<TaskActivityItem, { kind: "record" }>) {
  const name = (record: { name: string | null }) => record.name ?? "a record";
  if (item.from && item.to) {
    return (
      <>
        moved from <Value>{name(item.from)}</Value> to <Value>{name(item.to)}</Value>
      </>
    );
  }
  if (item.to) {
    return (
      <>
        linked to <Value>{name(item.to)}</Value>
      </>
    );
  }
  return item.from ? (
    <>
      removed from <Value>{name(item.from)}</Value>
    </>
  ) : null;
}

function InlinePerson(props: { person: Person }) {
  return (
    <span className="inline-flex items-baseline gap-1 align-baseline">
      <span className="relative top-0.5 inline-flex">
        <MemberAvatar name={props.person.name} image={props.person.image} size={14} />
      </span>
      <Value>{props.person.name}</Value>
    </span>
  );
}

function Avatar(props: { person: Person | null }) {
  return props.person ? (
    <MemberAvatar name={props.person.name} image={props.person.image} size={16} />
  ) : (
    <NoMemberAvatar size={16} />
  );
}

function Item(props: {
  mark: ReactNode;
  actor: Person | null;
  at: string;
  body?: string;
  children: ReactNode;
}) {
  return (
    <li className="relative flex flex-col gap-1.5">
      <div className="flex items-start gap-2.5 text-sm">
        <span className="flex h-5 w-3.75 shrink-0 items-center justify-center bg-background">
          {props.mark}
        </span>
        <p className="min-w-0 flex-1 leading-5 text-muted-foreground">
          <Value>{props.actor?.name ?? "Someone"}</Value> {props.children}
          <span className="tabular-nums"> · {ago(props.at)}</span>
        </p>
      </div>
      {props.body && (
        <p className="ps-6.25 text-sm leading-5 wrap-break-word whitespace-pre-wrap text-foreground">
          {props.body}
        </p>
      )}
    </li>
  );
}

function Composer(props: { task: CrmTask; source: TaskSource }) {
  const client = useQueryClient();
  const self = useMember().member.id;
  const comment = useMutation(commentOnTaskMutation(client, props.source, props.task.id, self));
  const [draft, setDraft] = useState("");
  const send = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    comment.mutate(body, {
      onError: (error) => {
        setDraft(body);
        crmErrorToast(error, "The comment was not added");
      },
    });
  };
  return (
    <NoteBox
      value={draft}
      onChange={setDraft}
      onSubmit={send}
      label="Comment"
      placeholder="Leave a comment…"
      submitLabel="Comment"
      maxLength={COMMENT_MAX}
    />
  );
}

function ActivityBones() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <SkeletonBox width={16} height={16} />
          <SkeletonBox width={`${45 + ((i * 13) % 30)}%`} height={10} />
        </div>
      ))}
    </div>
  );
}
