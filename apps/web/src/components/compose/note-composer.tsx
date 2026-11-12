// The composer's Note mode (shared inboxes, ADR 0021): an internal note for the team, never
// sent. Typing `@` offers the inbox's teammates; each one picked is notified. Tinted like the
// notes in the timeline, so it is never mistaken for a reply.
import { useRef, useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { ListBox, ListBoxItem } from "@/components/ui/list-box";
import { Popover } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { useAssignees } from "@/hooks/use-conversation.ts";
import { useAddNote } from "@/hooks/use-notes.ts";
import type { Assignee, Thread } from "@/lib/types.ts";
import { pictureUrl } from "@/lib/urls.ts";
import { Toolbar } from "./toolbar.tsx";

/** A teammate as the note names them: their name, or their address when they have none. */
const nameOf = (person: Assignee) => person.name || person.email;

/** At most this many teammates in the picker. */
const SUGGESTIONS = 6;

/** The `@word` being typed right before the caret, if any: its start and the word. */
function mentionAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  // After a space, a line break or the start, so an email address doesn't open the picker.
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  const word = match?.[2];
  if (word === undefined) return null;
  return { start: caret - word.length - 1, query: word.toLowerCase() };
}

export function NoteComposer({ thread, toggle }: { thread: Thread; toggle: ReactNode }) {
  const { data: assignees = [] } = useAssignees(thread.mailboxId);
  const addNote = useAddNote();
  const [text, setText] = useState("");
  // Teammates picked from the list; only those still named in the text are notified.
  const [picked, setPicked] = useState<Assignee[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const matches = mention
    ? assignees
        .filter(
          (a) =>
            nameOf(a).toLowerCase().includes(mention.query) ||
            a.email.toLowerCase().startsWith(mention.query),
        )
        .slice(0, SUGGESTIONS)
    : [];
  const open = matches.length > 0;

  const track = (next: string, caret: number) => {
    const found = mentionAt(next, caret);
    setMention(found);
    if (found?.query !== mention?.query) setHighlight(0);
  };

  const pick = (person: Assignee) => {
    if (!mention) return;
    const el = textarea.current;
    const caret = el?.selectionStart ?? text.length;
    const insert = `@${nameOf(person)} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    setText(next);
    setPicked((list) =>
      list.some((p) => p.memberId === person.memberId) ? list : [...list, person],
    );
    setMention(null);
    const at = mention.start + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };

  const canSend = text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    const body = text.trim();
    const mentions = picked.filter((p) => body.includes(`@${nameOf(p)}`)).map((p) => p.memberId);
    addNote.mutateAsync({ threadId: thread.id, body, mentions }).catch((error: Error) => {
      // Back in the box; if a new note was started meanwhile, keep it and hand the failed one
      // over on the clipboard, so neither is lost.
      if (textarea.current?.value.trim()) {
        void navigator.clipboard?.writeText(body).catch(() => undefined);
        appToast.error(error.message, { description: "The note's text is on your clipboard." });
      } else {
        setText(body);
        appToast.error(error.message);
      }
    });
    setText("");
    setPicked([]);
    setMention(null);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-warning-subtle p-3 shadow-raised">
      <div className="flex items-center justify-between gap-2">
        {toggle}
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          Only your team sees notes
        </span>
      </div>
      <Textarea
        ref={textarea}
        plain
        autoFocus
        aria-label="Note"
        placeholder="Write a note… @ to mention a teammate"
        rows={4}
        value={text}
        aria-expanded={open}
        aria-haspopup="listbox"
        onChange={(event) => {
          setText(event.target.value);
          track(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) => {
          const el = event.currentTarget;
          track(el.value, el.selectionStart);
        }}
        onKeyDown={(event) => {
          if (open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((i) => (i + step + matches.length) % matches.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              const person = matches[highlight];
              if (person) pick(person);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
        className="max-h-96 min-h-24 resize-none py-1 sm:py-1"
      />
      <Popover
        triggerRef={textarea}
        isOpen={open}
        isNonModal
        onOpenChange={(next) => !next && setMention(null)}
        placement="bottom start"
        className="min-w-56 p-0"
      >
        <ListBox
          aria-label="Mention a teammate"
          items={matches}
          // Re-renders the items when the highlight moves (the collection caches them by key).
          dependencies={[highlight]}
          onAction={(key) => {
            const person = matches.find((a) => a.memberId === key);
            if (person) pick(person);
          }}
          className="border-0"
        >
          {(person) => (
            <ListBoxItem
              id={person.memberId}
              textValue={nameOf(person)}
              // The arrow keys move this highlight while focus stays in the note.
              className={person.memberId === matches[highlight]?.memberId ? "bg-accent" : ""}
            >
              <span className="col-span-full flex min-w-0 items-center gap-2">
                <Avatar
                  size="xs"
                  src={pictureUrl(person.image)}
                  initials={nameOf(person).slice(0, 1).toUpperCase()}
                  className="size-4 shrink-0 [--avatar-size:--spacing(4)]"
                />
                <span className="truncate">{nameOf(person)}</span>
              </span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
      <Toolbar start={null} label="Add note" canSend={canSend} isPending={false} onSend={send} />
    </div>
  );
}
