import { cn } from "cn";
import { Skeleton, SkeletonBox } from "skullet/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { IconArrowUp, IconPlus, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { FileTrigger } from "@/components/ui/file-trigger";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { useMember } from "@/hooks/use-session.ts";
import {
  useReadThread,
  useSendFiles,
  useSendNote,
  useTalkMessages,
  useTalkPeople,
  useTalkThreadId,
} from "@/hooks/use-talk.ts";
import { inBackground } from "@/lib/desktop-notifications.ts";
import { firstName, noteToSend, type TalkPerson } from "@/lib/talk.ts";
import { EVERYONE, talkWindow, useTalkPinned, useTalkWindow } from "@/lib/talk-window.ts";
import { TalkEveryone } from "./talk-everyone";
import { TalkMessages } from "./talk-messages";

const WIDTH = 288;
const GUTTER = 12;
const BELOW = 6;
const CORNER = 28;

function Header(props: { person: TalkPerson }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-1.5 ps-4 pe-2">
      <h2 className="min-w-0 truncate text-sm">{props.person.name}</h2>
      {props.person.online && (
        <span aria-label="Active now" className="size-1.5 shrink-0 rounded-full bg-success" />
      )}
      <Button
        intent="ghost"
        size="sq-xs"
        aria-label="Close"
        onPress={talkWindow.close}
        className="ms-auto opacity-0 transition-opacity duration-150 group-hover/talk:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <IconX />
      </Button>
    </header>
  );
}

function Composer(props: {
  person: TalkPerson;
  threadId: string | undefined;
  pinned: boolean;
  meId: string;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const note = useSendNote(props.person.memberId, props.threadId);
  const files = useSendFiles(props.person.memberId, props.threadId);
  useEffect(() => {
    if (props.pinned) field.current?.focus();
  }, [props.pinned]);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    note.mutateAsync(noteToSend(body, props.meId)).catch(() => {
      setText((now) => (now.trim() ? now : body));
      appToast.error("The note was not sent. Try again.");
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };
  const attach = (list: File[]) =>
    list.length > 0 &&
    files.mutateAsync(list).catch(() => appToast.error("The file was not sent. Try again."));
  return (
    <div className="flex shrink-0 items-end gap-1 p-1.5 ps-4">
      <Textarea
        ref={field}
        plain
        aria-label={`Note to ${props.person.name}`}
        placeholder={`Note to ${firstName(props.person.name)}…`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-28 min-h-7 flex-1 resize-none py-1 sm:py-1"
      />
      <FileTrigger allowsMultiple onSelect={(list) => list && attach([...list])}>
        <Button
          intent="ghost"
          size="sq-sm"
          aria-label="Attach"
          isPending={files.isPending}
          className="rounded-[10px]"
        >
          <IconPlus />
        </Button>
      </FileTrigger>
      <Button
        intent="primary"
        size="sq-sm"
        aria-label="Drop"
        isDisabled={!text.trim()}
        onPress={send}
        className="rounded-[10px]"
      >
        <IconArrowUp />
      </Button>
    </div>
  );
}

function useReadWhileOpen(threadId: string | undefined, newest: string | undefined) {
  const read = useReadThread();
  useEffect(() => {
    if (!threadId) return;
    const now = () => {
      if (!inBackground()) void read(threadId);
    };
    now();
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [read, threadId, newest]);
}

function useEarlierAhead(
  earlier: { current: HTMLElement | null },
  more: boolean,
  pages: number,
  load: () => void,
) {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const button = earlier.current;
    if (!more || !button) return;
    const seen = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && latest.current(),
      { root: button.closest("[data-talk-scroll]"), rootMargin: "320px 0px" },
    );
    seen.observe(button);
    return () => seen.disconnect();
  }, [earlier, more, pages]);
}

function NoteBones() {
  return (
    <div className="flex flex-col items-end gap-1.5 px-3 py-2">
      <SkeletonBox width="60%" height={30} radius="var(--radius-2xl)" />
      <SkeletonBox width="40%" height={30} radius="var(--radius-2xl)" />
    </div>
  );
}

function Conversation(props: { person: TalkPerson; pinned: boolean }) {
  const { member } = useMember();
  const threadId = useTalkThreadId(props.person, props.pinned);
  const messages = useTalkMessages(threadId);
  const list = messages.data?.pages.flatMap((page) => page.messages) ?? [];
  useReadWhileOpen(threadId, list.find((m) => m.authorMemberId !== member.id)?.id);
  const earlier = useRef<HTMLButtonElement>(null);
  // WARNING: never page while any fetch runs: it would cancel a reconnect's refetch. It re-arms after.
  const pageable = messages.hasNextPage && !messages.isFetching;
  useEarlierAhead(earlier, pageable, messages.data?.pages.length ?? 0, () => {
    if (!messages.isFetching) void messages.fetchNextPage();
  });
  const files = useSendFiles(props.person.memberId, threadId);
  const [dragging, setDragging] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    if (!dropped.length) return;
    files.mutateAsync(dropped).catch(() => appToast.error("The file was not sent. Try again."));
  };

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col rounded-[inherit]",
        dragging && "ring-2 ring-ring ring-inset",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Header person={props.person} />
      <div
        data-talk-scroll
        className="flex h-80 max-h-[calc(100svh-12rem)] shrink-0 flex-col-reverse overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_12px)]"
      >
        {threadId && messages.isPending ? (
          <Skeleton loading label="Loading notes" skeleton={<NoteBones />}>
            {null}
          </Skeleton>
        ) : (
          <TalkMessages messages={list} meId={member.id} threadId={threadId ?? ""} />
        )}
        {messages.hasNextPage && (
          <Button
            ref={earlier}
            intent="plain"
            size="text"
            className="mx-auto mt-1 text-muted-foreground"
            isPending={messages.isFetchingNextPage}
            onPress={() => void messages.fetchNextPage()}
          >
            Earlier
          </Button>
        )}
      </div>
      <Composer person={props.person} threadId={threadId} pinned={props.pinned} meId={member.id} />
    </div>
  );
}

function useAnchor(memberId: string | null, width: number) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!memberId) return;
    const place = () => {
      const face =
        document.querySelector(`[data-talk-face="${CSS.escape(memberId)}"]`) ??
        document.querySelector("[data-talk-everyone]") ??
        document.querySelector("[data-notifications-toggle]");
      const box = face?.getBoundingClientRect();
      const centre = box ? box.left + box.width / 2 : window.innerWidth;
      const left = Math.min(
        Math.max(centre - width + CORNER, GUTTER),
        window.innerWidth - width - GUTTER,
      );
      setAt({ top: (box?.bottom ?? 42) + BELOW, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [memberId, width]);
  return at;
}

/**
 * The one conversation: a small white island just under the face it belongs to, the notes as
 * bubbles and the composer inside it. One window: moving to another face slides it there and
 * swaps the thread in place, and `+n` turns it into the people chooser. Mount once in the shell.
 */
export function TalkWindow() {
  const memberId = useTalkWindow();
  const pinned = useTalkPinned();
  const { data: people } = useTalkPeople();
  const everyone = memberId === EVERYONE;
  const person = memberId && !everyone ? people?.find((p) => p.memberId === memberId) : undefined;
  const width = Math.min(WIDTH, window.innerWidth - GUTTER * 2);
  const at = useAnchor(person || (everyone && people) ? memberId : null, width);
  useEffect(() => {
    if (!memberId) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) talkWindow.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [memberId]);
  if (!at || !people || !(person || everyone)) return null;
  return (
    <section
      aria-label={person ? `Conversation with ${person.name}` : "Everyone"}
      style={{ top: at.top, left: at.left, width }}
      onPointerEnter={talkWindow.stay}
      onPointerLeave={talkWindow.leave}
      onPointerDownCapture={talkWindow.pin}
      onFocusCapture={talkWindow.pin}
      className={cn(
        "group/talk fixed z-40 flex max-h-[calc(100svh-4rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-overlay",
        "origin-top animate-in fade-in zoom-in-95 duration-150 ease-out",
        "transition-[left] duration-200 ease-out motion-reduce:animate-none motion-reduce:transition-none",
      )}
    >
      {person ? (
        <Conversation key={person.memberId} person={person} pinned={pinned} />
      ) : (
        <TalkEveryone people={people} />
      )}
    </section>
  );
}
