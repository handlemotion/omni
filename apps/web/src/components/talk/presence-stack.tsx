import { cn } from "cn";
import { useEffect, type CSSProperties } from "react";
import { Avatar } from "@/components/ui/avatar";
import { IconComment, IconUsers, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { contextMenuProps } from "@/components/ui/context-menu";
import { usePrefetchThread, useTalkPeople } from "@/hooks/use-talk.ts";
import { stackOf, type TalkPerson } from "@/lib/talk.ts";
import { EVERYONE, talkWindow, useTalkWindow } from "@/lib/talk-window.ts";
import { pictureUrl } from "@/lib/urls.ts";

const FACE = 24;
const OVERLAP = "-ms-2 first:ms-0";
const RING = "ring-2 ring-shell";

export function TalkFace(props: {
  person: Pick<TalkPerson, "name" | "image">;
  size: number;
  className?: string;
}) {
  return (
    <Avatar
      src={pictureUrl(props.person.image)}
      initials={props.person.name.slice(0, 1).toUpperCase()}
      alt=""
      className={cn("bg-secondary text-muted-foreground outline-0", props.className)}
      style={{ "--avatar-size": `${props.size}px` } as CSSProperties}
    />
  );
}

function Dot(props: { tone: "unread" | "online"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute bottom-0 size-2 rounded-full ring-2 ring-shell",
        props.tone === "unread" ? "start-0 bg-primary" : "end-0 bg-success",
        props.className,
      )}
    />
  );
}

const label = (person: TalkPerson) =>
  [person.name, person.unread ? `${person.unread} unread` : null, person.online ? null : "offline"]
    .filter(Boolean)
    .join(", ");

function StackFace(props: { person: TalkPerson; open: boolean }) {
  const { person, open } = props;
  const prefetch = usePrefetchThread();
  return (
    <Button
      intent="plain"
      size="sq-sm"
      isCircle
      aria-label={label(person)}
      aria-pressed={open}
      data-talk-face={person.memberId}
      onPointerEnter={(event) => {
        prefetch(person);
        if (event.pointerType === "mouse") talkWindow.hover(person.memberId);
      }}
      onPointerLeave={(event) => event.pointerType === "mouse" && talkWindow.leave()}
      onPress={() =>
        open && talkWindow.state().pinned ? talkWindow.close() : talkWindow.open(person.memberId)
      }
      className={cn(
        "relative transition-transform duration-150 ease-out motion-reduce:transition-none",
        OVERLAP,
        open && "z-10 -translate-y-0.5",
      )}
    >
      <TalkFace
        person={person}
        size={FACE}
        className={cn(
          "bg-background transition-opacity duration-150",
          RING,
          open && "ring-primary",
          !person.online && !open && "opacity-45 grayscale",
        )}
      />
      {person.unread > 0 && <Dot tone="unread" />}
    </Button>
  );
}

function Everyone(props: { more: number; open: boolean }) {
  return (
    <Button
      intent="plain"
      size="sq-sm"
      isCircle
      aria-label={`Everyone, ${props.more} more`}
      aria-pressed={props.open}
      data-talk-everyone
      onPointerEnter={(event) => event.pointerType === "mouse" && talkWindow.hover(EVERYONE)}
      onPointerLeave={(event) => event.pointerType === "mouse" && talkWindow.leave()}
      onPress={() =>
        props.open && talkWindow.state().pinned ? talkWindow.close() : talkWindow.open(EVERYONE)
      }
      className={cn(OVERLAP, props.open && "z-10 -translate-y-0.5")}
    >
      <span
        className={cn(
          "grid size-6 place-items-center rounded-full bg-background text-xs text-muted-foreground tabular-nums",
          RING,
          props.open && "ring-primary",
        )}
      >
        +{props.more}
      </span>
    </Button>
  );
}

function usePrefetchUnread(people: TalkPerson[] | undefined) {
  const prefetch = usePrefetchThread();
  useEffect(() => {
    const unread = people?.filter((p) => p.unread > 0 && p.threadId) ?? [];
    if (unread.length === 0) return;
    const run = () => unread.forEach(prefetch);
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(run, 200);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(run, { timeout: 2_000 });
    return () => cancelIdleCallback(idle);
  }, [people, prefetch]);
}

/**
 * The workspace's teammates in the title bar, online or not (offline ones dimmed): up to three
 * faces, then `+n` for everyone. Nothing when there is nobody else, or the workspace has no Talk.
 */
export function PresenceStack() {
  const { data: people } = useTalkPeople();
  const openId = useTalkWindow();
  usePrefetchUnread(people);
  if (!people?.length) return null;
  const { shown, more } = stackOf(people);
  if (shown.length === 0) return null;
  const menu = contextMenuProps((target) => {
    const id = target.closest("[data-talk-everyone]")
      ? EVERYONE
      : target.closest("[data-talk-face]")?.getAttribute("data-talk-face");
    const person = people.find((p) => p.memberId === id);
    if (!id || (id !== EVERYONE && !person)) return null;
    return [
      {
        icon: id === EVERYONE ? IconUsers : IconComment,
        label: id === EVERYONE ? "Message everyone" : `Message ${person?.name ?? ""}`,
        onAction: () => talkWindow.open(id),
      },
      id === openId && { icon: IconX, label: "Close", onAction: () => talkWindow.close() },
    ];
  }, "Teammate actions");
  return (
    <div role="group" aria-label="Teammates" className="me-1.5 flex items-center" {...menu}>
      {shown.map((person) => (
        <StackFace key={person.memberId} person={person} open={person.memberId === openId} />
      ))}
      {more > 0 && <Everyone more={more} open={openId === EVERYONE} />}
    </div>
  );
}
