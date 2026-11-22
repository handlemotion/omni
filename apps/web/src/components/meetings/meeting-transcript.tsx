import { useMemo, useState } from "react";
import { Skeleton } from "skullet/react";
import { IconCheck, IconCopy } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { appToast } from "@/components/ui/toast";
import { useClipboard } from "@/hooks/use-clipboard.ts";
import { useMeetingTranscript, useMeetingWrites } from "@/hooks/use-meetings.ts";
import { meetingClock, type Meeting, type MeetingSegment } from "@/lib/meetings.ts";
import { usePlayer } from "./meeting-player.tsx";

/** Each speaker's name, by the engine's label: the name given, else `Speaker N`. */
export function speakerNames(meeting: Meeting) {
  return new Map(meeting.speakers.map((s, i) => [s.label, s.name ?? `Speaker ${i + 1}`]));
}

const initial = (name: string) => name.trim().slice(0, 1).toUpperCase();

/** Who said what, turn by turn: a face, a name to fix, the time to play from, the words. */
export function MeetingTranscript(props: { meeting: Meeting; canRename: boolean }) {
  const id = props.meeting.meeting.id;
  const transcript = useMeetingTranscript(id);
  const [query, setQuery] = useState("");
  const { copy, copied } = useClipboard();
  const player = usePlayer();
  const names = speakerNames(props.meeting);
  const nameOf = (segment: MeetingSegment) => names.get(segment.speaker ?? "") ?? "Unknown";
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = transcript.data ?? [];
    return needle ? all.filter((s) => s.text.toLowerCase().includes(needle)) : all;
  }, [transcript.data, query]);
  const text = () =>
    (transcript.data ?? [])
      .map((s) => `[${meetingClock(s.startMs)}] ${nameOf(s)}: ${s.text}`)
      .join("\n");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SearchField
          aria-label="Find in transcript"
          value={query}
          onChange={setQuery}
          className="min-w-0 flex-1"
        >
          <SearchInput placeholder="Find in transcript" />
        </SearchField>
        <Button intent="outline" size="sm" onPress={() => void copy(text())}>
          {copied ? <IconCheck data-slot="icon" /> : <IconCopy data-slot="icon" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Skeleton loading={transcript.isPending} label="Loading">
        <ol className="-mx-3 flex flex-col gap-1">
          {shown.map((segment) => {
            const now =
              player.playing && player.timeMs >= segment.startMs && player.timeMs < segment.endMs;
            return (
              <li
                key={segment.seq}
                aria-current={now ? "true" : undefined}
                className="flex flex-col gap-y-1 rounded-xl px-3 py-2.5 transition-colors duration-150 ease-out aria-current:bg-accent"
              >
                <div className="flex h-6 items-center gap-2">
                  <Avatar size="xs" initials={initial(nameOf(segment))} />
                  {props.canRename && segment.speaker ? (
                    <SpeakerMenu
                      meeting={props.meeting}
                      label={segment.speaker}
                      name={nameOf(segment)}
                    />
                  ) : (
                    <span className="text-sm">{nameOf(segment)}</span>
                  )}
                  <Button
                    intent="plain"
                    size="sm"
                    isDisabled={!player.hasAudio}
                    aria-label={`Play from ${meetingClock(segment.startMs)}`}
                    onPress={() => player.seek(segment.startMs)}
                    className="-ms-1 text-xs text-muted-foreground tabular-nums"
                  >
                    {meetingClock(segment.startMs)}
                  </Button>
                </div>
                <p className="ps-7 text-sm/6 text-foreground">{segment.text}</p>
              </li>
            );
          })}
        </ol>
      </Skeleton>
    </div>
  );
}

function SpeakerMenu(props: { meeting: Meeting; label: string; name: string }) {
  const { renameSpeaker } = useMeetingWrites();
  return (
    <MenuTrigger>
      <Button intent="plain" size="sm" className="-ms-2 text-sm">
        {props.name}
      </Button>
      <Menu
        aria-label={`Who is ${props.name}`}
        onAction={(key) => {
          const person = props.meeting.attendees.find((a) => a.address === key);
          if (!person) return;
          renameSpeaker.mutate(
            {
              id: props.meeting.meeting.id,
              label: props.label,
              name: person.name ?? person.address,
              address: person.address,
            },
            { onError: () => appToast.error("The speaker could not be renamed") },
          );
        }}
      >
        {props.meeting.attendees.map((person) => (
          <MenuItem
            key={person.address}
            id={person.address}
            textValue={person.name ?? person.address}
          >
            <Avatar size="xs" initials={initial(person.name ?? person.address)} />
            <MenuLabel>{person.name ?? person.address}</MenuLabel>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}
