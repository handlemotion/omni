// The composer's Hidden mode (shared inboxes, ADR 0021): an internal note for the team, never
// sent, written like a chat message. The box is the AI composer from handlemotion/dorks
// (`ChatComposer.tsx`, the AI Elements prompt input) on Omni's primitives: one row that grows
// into a box once the text wraps, a button at each bottom corner, Enter to send, Shift+Enter
// for a new line, and a reply banner on top when answering a passage of the conversation.
// Typing `@` (or the @ button) offers the inbox's teammates; each one picked is notified.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { IconArrowUp, IconAt, IconReply, IconX } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ListBox, ListBoxItem } from "@/components/ui/list-box";
import { AriaPopover as Popover } from "@/components/ui/aria-popover";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useAssignees } from "@/hooks/use-conversation.ts";
import { useAddNote } from "@/hooks/use-notes.ts";
import { replyLabel, withReply, type Reply } from "@/lib/reply.ts";
import type { Assignee, Thread } from "@/lib/types.ts";
import { pictureUrl } from "@/lib/urls.ts";
import { useComposerState } from "./composer-state.tsx";

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

/** Whether the text runs past one line; re-measured as it changes and as the box resizes. */
function useWraps(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
  const [wraps, setWraps] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const content =
        el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setWraps(content > parseFloat(style.lineHeight) * 1.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, text]);
  return wraps;
}

/**
 * A shared conversation's hidden notes, floating 16px off the pane's bottom in the messages'
 * column; they scroll under it. Gone while an email is written.
 */
export function ChatDock({ thread }: { thread: Thread }) {
  const { chat, chatOpen, mode } = useComposerState();
  const active = chatOpen && mode === "hidden";
  if (!chat) return null;
  return (
    // Kept mounted while an email is written or the email view shows, so a half-written note
    // waits here.
    <div hidden={!active} className="relative mx-auto w-full max-w-3xl px-5 pb-4">
      <div className="relative">
        <ChatComposer key={thread.id} thread={thread} active={active} />
      </div>
    </div>
  );
}

export function ChatComposer({ thread, active }: { thread: Thread; active: boolean }) {
  const { reply, seed, clearReply, replyInChat } = useComposerState();
  const { data: assignees = [] } = useAssignees(thread.mailboxId);
  const addNote = useAddNote();
  const [text, setText] = useState("");
  // Teammates picked from the list; only those still named in the text are notified.
  const [picked, setPicked] = useState<Assignee[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // One row until the text wraps; then the text takes the box and the buttons sit under it.
  const stacked = useWraps(textarea, text);

  // Switching to Chat, or a new reply, puts the cursor in the box, ready to write.
  useEffect(() => {
    if (active) textarea.current?.focus();
  }, [active, reply]);
  // Words typed in a selection's reply box arrive here, after anything already written.
  useEffect(() => {
    if (seed)
      setText((current) => (current.trim() ? `${current.trimEnd()} ${seed.text}` : seed.text));
  }, [seed]);

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

  /** The @ button: an `@` at the caret (after a space when needed), which opens the picker. */
  const startMention = () => {
    const el = textarea.current;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? at;
    const insert = at > 0 && !/\s/.test(text[at - 1] ?? "") ? " @" : "@";
    const next = text.slice(0, at) + insert + text.slice(end);
    setText(next);
    const caret = at + insert.length;
    track(next, caret);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const canSend = text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    const written = text.trim();
    const replied = reply;
    const body = withReply(replied, written);
    const mentions = picked.filter((p) => written.includes(`@${nameOf(p)}`)).map((p) => p.memberId);
    addNote.mutateAsync({ threadId: thread.id, body, mentions }).catch((error: Error) => {
      // Back in the box with its reply; if a new message was started meanwhile, keep it and
      // hand the failed one (quote included) over on the clipboard, so neither is lost.
      if (textarea.current?.value.trim()) {
        void navigator.clipboard?.writeText(body).catch(() => undefined);
        appToast.error(error.message, { description: "The message is on your clipboard." });
      } else {
        setText(written);
        if (replied) replyInChat(replied);
        appToast.error(error.message);
      }
    });
    setText("");
    setPicked([]);
    setMention(null);
    clearReply();
  };

  return (
    <div className="flex flex-col">
      {/* 12px corners: the reply banner 8px inside keeps 4px, concentric. Dotted with no fill, like
          the hidden notes it adds. */}
      <div
        ref={box}
        className="relative flex flex-col rounded-[12px] border border-dashed border-muted-foreground/40 focus-within:border-ring/70"
      >
        {reply && (
          // The banner sits 8px inside the box (the buttons' inset), concentric with its corners.
          <div className="px-2 pt-2">
            <ReplyBanner
              reply={reply}
              onClear={() => {
                clearReply();
                textarea.current?.focus();
              }}
            />
          </div>
        )}
        <Textarea
          ref={textarea}
          plain
          aria-label="Hidden note"
          placeholder="Hidden note for your team, @ to mention"
          rows={1}
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
            if (event.key === "Escape" && reply) {
              event.preventDefault();
              clearReply();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          // A 44px row: 12px above and below a 20px line. The text starts 42px in (past the 28px
          // Mention button, its 8px edge, and 6px more) and ends 42px in (past Send).
          // Stacked, the bottom inset makes room for the button row (16px gap, 28px button, 8px edge).
          className={`max-h-[40vh] min-h-0 resize-none ps-[42px] pe-[42px] py-3 text-sm/5 sm:ps-[42px] sm:pe-[42px] sm:py-3 sm:text-sm/5 ${
            stacked ? "pb-13 sm:pb-13" : ""
          }`}
        />
        {/* The button keeps one spot, 8px from the bottom corners, one row or stacked. */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1">
          <TooltipTrigger delay={400}>
            <Button
              intent="ghost"
              size="sq-sm"
              aria-label="Mention a teammate"
              className="text-muted-foreground hover:text-foreground"
              onPress={startMention}
            >
              <IconAt />
            </Button>
            <Tooltip>Mention a teammate</Tooltip>
          </TooltipTrigger>
        </div>
        <div className="absolute right-2 bottom-2">
          <TooltipTrigger delay={400}>
            <Button size="sq-sm" aria-label="Add hidden note" isDisabled={!canSend} onPress={send}>
              <IconArrowUp />
            </Button>
            <Tooltip>Add hidden note ↵</Tooltip>
          </TooltipTrigger>
        </div>
      </div>
      <Popover
        triggerRef={box}
        isOpen={open}
        isNonModal
        onOpenChange={(next) => !next && setMention(null)}
        placement="top start"
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
              // The arrow keys move this highlight while focus stays in the box.
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
    </div>
  );
}

/** The reply as one quiet line: who wrote it and the quoted words, cut to one line. */
export function ReplyLine({ reply, className = "" }: { reply: Reply; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-2 ${className}`}>
      <IconReply aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {reply.from}: “{replyLabel(reply)}”
      </span>
    </span>
  );
}

/** The chat box's banner: what the next message replies to, and an X to drop it. */
function ReplyBanner({ reply, onClear }: { reply: Reply; onClear: () => void }) {
  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-1 rounded-sm bg-accent ps-2.5 pe-1 text-[13px] text-muted-foreground">
      <ReplyLine reply={reply} className="flex-1" />
      <TooltipTrigger delay={400}>
        <Button
          intent="ghost"
          size="sq-xs"
          aria-label="Remove reply"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onPress={onClear}
        >
          <IconX />
        </Button>
        <Tooltip>Remove reply</Tooltip>
      </TooltipTrigger>
    </div>
  );
}
