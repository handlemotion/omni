// A shared inbox's activity between the messages (ADR 0021): internal notes, and one quiet line
// per change ("Ana assigned this to Luis", "Reopened by the customer's reply"). Names come from
// the inbox's assignees; someone who has since lost access reads as "A teammate".
import { useState } from "react";
import { IconLock, IconPencil, IconTrash } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { MenuItem, MenuLabel } from "@/components/ui/menu";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { useAssignees, useTags } from "@/hooks/use-conversation.ts";
import { isPendingNote, useDeleteNote, useEditNote } from "@/hooks/use-notes.ts";
import { useSession } from "@/hooks/use-session.ts";
import { parseReply, withReply, type Reply } from "@/lib/reply.ts";
import type { Assignee, ConversationEvent, Note, Priority } from "@/lib/types.ts";
import { pictureUrl } from "@/lib/urls.ts";
import { ReplyLine } from "../compose/chat-composer.tsx";
import { REPLY_SOURCE } from "../compose/selection-reply.tsx";
import { messageTime } from "./message.tsx";
import { MessageMenu } from "./message-menu.tsx";

const PRIORITY: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

const TARGET: Record<string, string> = {
  first_response: "First response",
  next_response: "Next response",
  resolution: "Resolution",
};

const SNOOZE_UNTIL = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** Names of the inbox's members, with "You" for the person reading. */
function usePeople(mailboxId: string) {
  const { data: assignees = [] } = useAssignees(mailboxId);
  const email = useSession().data?.user.email;
  const find = (memberId: unknown) =>
    typeof memberId === "string" ? assignees.find((a) => a.memberId === memberId) : undefined;
  const name = (memberId: unknown) => {
    const person = find(memberId);
    if (!person) return "A teammate";
    return person.email === email ? "You" : person.name || person.email;
  };
  // Mid-sentence: "assigned this to you", not "to You".
  const object = (memberId: unknown) => {
    const n = name(memberId);
    return n === "You" ? "you" : n;
  };
  // As a note's text names them (the composer writes `@` and this), "You" or not.
  const written = (memberId: unknown) => {
    const person = find(memberId);
    return person ? person.name || person.email : null;
  };
  return {
    find,
    name,
    object,
    written,
    isYou: (memberId: unknown) => find(memberId)?.email === email,
  };
}

/** The sentence for one event, or null for the ones the timeline leaves out. */
function useDescribe(mailboxId: string) {
  const people = usePeople(mailboxId);
  const { data: tags = [] } = useTags(mailboxId);
  return (event: ConversationEvent): string | null => {
    const data = event.data as Record<string, unknown>;
    const actor = event.actorMemberId ? people.name(event.actorMemberId) : null;
    switch (event.kind) {
      case "status": {
        const cause = data.cause;
        if (cause === "customer_message") return "Reopened by the customer's reply";
        if (cause === "snooze_expired") return "Back from snooze";
        // A reply moves it to Pending each time: the reply itself says so.
        if (cause === "agent_reply") return null;
        // A hand-off resolves it: the hand-off line says so.
        if (cause === "handoff") return null;
        if (cause === "handoff_cancelled") return `${actor ?? "Omni"} cancelled the hand-off`;
        if (data.reason === "discarded_elsewhere")
          return "Resolved: moved to Trash or Junk in another mail app";
        const who = actor ?? "Omni";
        if (data.to === "resolved") return `${who} resolved this`;
        if (data.to === "snoozed") {
          const until = typeof data.snoozedUntil === "string" ? new Date(data.snoozedUntil) : null;
          return until
            ? `${who} snoozed this until ${SNOOZE_UNTIL.format(until)}`
            : `${who} snoozed this`;
        }
        if (data.to === "open") return `${who} reopened this`;
        if (data.to === "pending") return `${who} marked this pending`;
        return null;
      }
      case "assigned": {
        // Part of a hand-off or its undo: their own line says so.
        if (data.cause === "handoff" || data.cause === "handoff_cancelled") return null;
        if (data.cause === "auto_assign")
          return `Assigned to ${people.object(data.to)} automatically`;
        // The first reply claims an unowned conversation.
        if (data.cause === "first_reply") return `${people.name(data.to)} took this by replying`;
        const who = actor ?? "Omni";
        if (!data.to) return `${who} unassigned ${people.object(data.from)}`;
        if (data.to === event.actorMemberId) return `${who} took this`;
        return `${who} assigned this to ${people.object(data.to)}`;
      }
      case "priority": {
        const to = PRIORITY[data.to as Priority] ?? String(data.to);
        return `${data.source === "ai" || !actor ? "Omni" : actor} set priority to ${to}`;
      }
      case "tag_added":
      case "tag_removed": {
        const tag = tags.find((t) => t.id === data.tagId)?.name;
        const who = data.source === "ai" || !actor ? "Omni" : actor;
        const verb = event.kind === "tag_added" ? "tagged this" : "removed the tag";
        return tag ? `${who} ${verb} ${tag}` : null;
      }
      case "sla_at_risk":
      case "sla_breached": {
        const target = TARGET[String(data.target)] ?? "Response";
        return event.kind === "sla_at_risk" ? `${target} due soon` : `${target} overdue`;
      }
      case "merged":
        return "Another conversation was merged into this one";
      case "handoff":
        return `${actor ?? "A teammate"} continued this conversation in their inbox`;
      // The note shows itself; the first response is the reply above it.
      default:
        return null;
    }
  };
}

/** Pairs each event with its sentence, dropping the ones left out. */
export function useEventLines(mailboxId: string, events: ConversationEvent[]) {
  const describe = useDescribe(mailboxId);
  return events.flatMap((event) => {
    const text = describe(event);
    return text ? [{ event, text }] : [];
  });
}

/** "Ana assigned this to Luis · 3:04 PM", centred and quiet between the messages. */
export function EventLine(props: { event: ConversationEvent; text: string }) {
  const danger = props.event.kind === "sla_breached";
  return (
    <p
      // 8px more above and below than the timeline's gap, like "Ana added Bob".
      className={`py-2 text-center text-xs ${danger ? "text-danger-subtle-foreground" : "text-subtle-foreground"}`}
    >
      {props.text}
      <span aria-hidden> · </span>
      <time dateTime={props.event.createdAt} className="tabular-nums">
        {messageTime(props.event.createdAt)}
      </time>
    </p>
  );
}

/**
 * An internal note: only the team sees it. A bubble on the team's side, with the mentioned
 * teammates' names standing out. The author can edit or delete their own.
 */
export function NoteItem(props: { threadId: string; mailboxId: string; note: Note }) {
  const { note } = props;
  const people = usePeople(props.mailboxId);
  const author = people.find(note.authorMemberId);
  const name = people.name(note.authorMemberId);
  const mine = people.isYou(note.authorMemberId);
  const [editing, setEditing] = useState(false);
  const pending = isPendingNote(note);
  const edited = note.updatedAt !== note.createdAt;
  // A chat reply carries its quote in the body; it shows above the bubble instead.
  const { reply, body } = parseReply(note.body);
  const from = people.written(note.authorMemberId) ?? name;

  return (
    // On the right with the replies, since the team wrote it. The dotted outline, the lock and
    // "Hidden" tell it from a reply the customer got.
    <article
      aria-label={`Note from ${name}, ${messageTime(note.createdAt)}`}
      className="group/item flex flex-col items-end gap-3"
    >
      <header className="flex items-center gap-2">
        {!mine && <Face person={author} name={name} />}
        <span className="text-sm">{name}</span>
        <span className="flex items-center gap-1 text-xs text-subtle-foreground">
          <IconLock className="size-3" />
          Hidden
        </span>
        <time dateTime={note.createdAt} className="text-xs text-subtle-foreground tabular-nums">
          {messageTime(note.createdAt)}
          {edited && " · edited"}
        </time>
        {!pending && !editing && (
          <MessageMenu
            start
            label="Note actions"
            from={from}
            text={body}
            extra={
              mine && (
                <NoteActions
                  threadId={props.threadId}
                  noteId={note.id}
                  onEdit={() => setEditing(true)}
                />
              )
            }
          />
        )}
      </header>
      {reply && !editing && (
        <div
          title={reply.text}
          className="flex max-w-[80%] justify-end text-xs text-muted-foreground"
        >
          <ReplyLine reply={reply} />
        </div>
      )}
      <div
        {...{ [REPLY_SOURCE]: from }}
        // Hidden from the customer: a dotted outline with no fill, never a mail bubble.
        className={`rounded-xl border border-dashed border-muted-foreground/40 px-3 py-2 text-foreground ${
          editing ? "w-full" : "max-w-[80%]"
        } ${pending ? "opacity-70" : ""}`}
      >
        {editing ? (
          <EditNote
            threadId={props.threadId}
            note={note}
            reply={reply}
            body={body}
            onDone={() => setEditing(false)}
          />
        ) : (
          <NoteBody body={body} names={note.mentions.flatMap((id) => people.written(id) ?? [])} />
        )}
      </div>
    </article>
  );
}

/** The note's text, each `@Name` of a mentioned teammate in the foreground weight. */
function NoteBody({ body, names }: { body: string; names: string[] }) {
  const mentions = names.map((n) => `@${n}`);
  // Longest first, so "@Ana Lopez" wins over "@Ana".
  mentions.sort((a, b) => b.length - a.length);
  const parts: { text: string; mention: boolean }[] = [];
  let rest = body;
  while (rest) {
    let at = -1;
    let hit = "";
    for (const m of mentions) {
      const i = rest.indexOf(m);
      if (i !== -1 && (at === -1 || i < at)) [at, hit] = [i, m];
    }
    if (at === -1) {
      parts.push({ text: rest, mention: false });
      break;
    }
    if (at > 0) parts.push({ text: rest.slice(0, at), mention: false });
    parts.push({ text: hit, mention: true });
    rest = rest.slice(at + hit.length);
  }
  return (
    <p className="text-sm/5 break-words whitespace-pre-wrap">
      {parts.map((p, i) =>
        p.mention ? (
          <span key={i} className="font-medium">
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </p>
  );
}

/** Your own note's items in its menu: edit and delete. */
function NoteActions(props: { threadId: string; noteId: string; onEdit: () => void }) {
  const remove = useDeleteNote();
  return (
    <>
      <MenuItem textValue="Edit" onAction={props.onEdit}>
        <IconPencil data-slot="icon" />
        <MenuLabel>Edit</MenuLabel>
      </MenuItem>
      <MenuItem
        intent="danger"
        textValue="Delete"
        onAction={() =>
          remove.mutate(
            { threadId: props.threadId, noteId: props.noteId },
            { onError: (error) => appToast.error(error.message) },
          )
        }
      >
        <IconTrash data-slot="icon" />
        <MenuLabel>Delete</MenuLabel>
      </MenuItem>
    </>
  );
}

/** Edits the words only: a reply's quote stays as it was. */
function EditNote(props: {
  threadId: string;
  note: Note;
  reply: Reply | undefined;
  body: string;
  onDone: () => void;
}) {
  const edit = useEditNote();
  const [body, setBody] = useState(props.body);
  const save = () => {
    const next = body.trim();
    if (!next || next === props.body) return props.onDone();
    edit.mutate(
      { threadId: props.threadId, noteId: props.note.id, body: withReply(props.reply, next) },
      { onError: (error) => appToast.error(error.message) },
    );
    props.onDone();
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        plain
        autoFocus
        aria-label="Edit note"
        value={body}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
          if (event.key === "Escape") props.onDone();
        }}
        className="resize-none py-0 sm:py-0"
      />
      <div className="flex justify-end gap-1">
        <Button intent="plain" size="sm" onPress={props.onDone}>
          Cancel
        </Button>
        <Button size="sm" isDisabled={!body.trim()} onPress={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Face({ person, name }: { person: Assignee | undefined; name: string }) {
  return (
    <Avatar
      isSquare
      size="xs"
      src={pictureUrl(person?.image ?? null)}
      initials={name.slice(0, 1).toUpperCase()}
      // 18px: a step under the xs avatar, so the face sits with the 14px name, not over it.
      className="bg-accent text-foreground outline-0 [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(4.5)]"
    />
  );
}
