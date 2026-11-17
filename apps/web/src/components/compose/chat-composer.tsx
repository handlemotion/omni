import { useEffect, useRef, useState } from "react";
import { IconAt } from "@/components/icons/central";
import { ChatBox, ReplyBanner } from "@/components/chat/chat-box";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ListBox, ListBoxItem } from "@/components/ui/list-box";
import { AriaPopover as Popover } from "@/components/ui/aria-popover";
import { appToast } from "@/components/ui/toast";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useAssignees } from "@/hooks/use-conversation.ts";
import { useAddNote } from "@/hooks/use-notes.ts";
import { withReply } from "@/lib/reply.ts";
import type { Assignee, Thread } from "@/lib/types.ts";
import { pictureUrl } from "@/lib/urls.ts";
import { useComposerState } from "./composer-state.tsx";

const nameOf = (person: Assignee) => person.name || person.email;

const SUGGESTIONS = 6;

function mentionAt(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  const word = match?.[2];
  if (word === undefined) return null;
  return { start: caret - word.length - 1, query: word.toLowerCase() };
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
  const [picked, setPicked] = useState<Assignee[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) textarea.current?.focus();
  }, [active, reply]);
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
      <ChatBox
        textareaRef={textarea}
        boxRef={box}
        dashed
        label="Hidden note"
        placeholder="Hidden note for your team, @ to mention"
        sendLabel="Add hidden note"
        canSend={canSend}
        onSend={send}
        value={text}
        textareaProps={{ "aria-expanded": open, "aria-haspopup": "listbox" }}
        onChange={(next, caret) => {
          setText(next);
          track(next, caret);
        }}
        onSelect={track}
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
          }
        }}
        banner={
          reply && (
            <ReplyBanner
              reply={reply}
              onClear={() => {
                clearReply();
                textarea.current?.focus();
              }}
            />
          )
        }
        leading={
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
        }
      />
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
