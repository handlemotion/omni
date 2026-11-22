import { cn } from "cn";
import { IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { everyoneOf, type TalkPerson } from "@/lib/talk.ts";
import { talkWindow } from "@/lib/talk-window.ts";
import { TalkFace } from "./presence-stack";

function Row(props: { person: TalkPerson }) {
  const { person } = props;
  return (
    <li>
      <Button
        intent="plain"
        size="text"
        aria-label={person.online ? person.name : `${person.name}, offline`}
        onPress={() => talkWindow.open(person.memberId)}
        className="flex w-full items-center justify-start gap-3 rounded-lg px-2 py-1.5 text-start hover:bg-secondary"
      >
        <span className="relative grid size-7 shrink-0 place-items-center">
          <TalkFace
            person={person}
            size={28}
            className={cn(!person.online && "opacity-45 grayscale")}
          />
          {person.online && (
            <span
              aria-hidden
              className="absolute end-0 bottom-0 size-2 rounded-full bg-success ring-2 ring-background"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
        {person.unread > 0 && (
          <span className="text-xs text-subtle-foreground tabular-nums">{person.unread}</span>
        )}
      </Button>
    </li>
  );
}

/** The window as the people chooser, opened from `+n`: everyone, online first; one opens their thread. */
export function TalkEveryone(props: { people: TalkPerson[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center ps-4 pe-2">
        <h2 className="min-w-0 flex-1 truncate text-sm">Everyone</h2>
        <Button
          intent="ghost"
          size="sq-xs"
          aria-label="Close"
          onPress={talkWindow.close}
          className="opacity-0 transition-opacity duration-150 group-hover/talk:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <IconX />
        </Button>
      </header>
      <ul className="flex h-[calc(20rem+2.75rem)] max-h-[calc(100svh-12rem)] flex-col overflow-y-auto px-2 pb-2">
        {everyoneOf(props.people).map((person) => (
          <Row key={person.memberId} person={person} />
        ))}
      </ul>
    </div>
  );
}
