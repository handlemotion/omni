import { cn } from "cn";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useTalkPeople } from "@/hooks/use-talk.ts";
import { everyoneOf, stackOf, type TalkPerson } from "@/lib/talk.ts";
import { talkWindow, useTalkWindow } from "@/lib/talk-window.ts";
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
  return (
    <Button
      intent="plain"
      size="sq-sm"
      isCircle
      aria-label={label(person)}
      aria-pressed={open}
      data-talk-face={person.memberId}
      onPointerEnter={(event) => event.pointerType === "mouse" && talkWindow.hover(person.memberId)}
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

function Everyone(props: { people: TalkPerson[]; more: number; openId: string | null }) {
  return (
    <MenuTrigger>
      <TooltipTrigger delay={400}>
        <Button
          intent="plain"
          size="sq-sm"
          isCircle
          aria-label={`Everyone, ${props.more} more`}
          data-talk-everyone
          className={OVERLAP}
        >
          <span
            className={cn(
              "grid size-6 place-items-center rounded-full bg-background text-xs text-muted-foreground tabular-nums",
              RING,
            )}
          >
            +{props.more}
          </span>
        </Button>
        <Tooltip>Everyone</Tooltip>
      </TooltipTrigger>
      <Menu
        placement="bottom end"
        popover={{ offset: 6, collisionPadding: 8, className: "min-w-64 max-w-80" }}
        className="p-2"
      >
        {everyoneOf(props.people).map((person) => (
          <MenuItem
            key={person.memberId}
            textValue={person.name}
            className="min-h-10 rounded-sm ps-2 pe-3 py-1.5"
            onAction={() => talkWindow.open(person.memberId)}
          >
            <span className="col-span-full flex min-w-0 items-center gap-3">
              <span className="relative grid size-7 shrink-0 place-items-center">
                <TalkFace person={person} size={28} />
                {person.online && <Dot tone="online" className="ring-overlay" />}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  person.memberId === props.openId && "font-medium",
                )}
              >
                {person.name}
              </span>
              {person.unread > 0 && (
                <span className="text-xs text-subtle-foreground tabular-nums">{person.unread}</span>
              )}
            </span>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}

/**
 * The workspace's teammates in the title bar, online or not (offline ones dimmed): up to three
 * faces, then `+n` for everyone. Nothing when there is nobody else, or the workspace has no Talk.
 */
export function PresenceStack() {
  const { data: people } = useTalkPeople();
  const openId = useTalkWindow();
  if (!people?.length) return null;
  const { shown, more } = stackOf(people);
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label="Teammates" className="me-1.5 flex items-center">
      {shown.map((person) => (
        <StackFace key={person.memberId} person={person} open={person.memberId === openId} />
      ))}
      {more > 0 && <Everyone people={people} more={more} openId={openId} />}
    </div>
  );
}
