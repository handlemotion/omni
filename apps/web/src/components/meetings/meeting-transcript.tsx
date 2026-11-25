import { memo, useDeferredValue, useMemo, useState } from "react";
import { Skeleton } from "skullet/react";
import { IconCheck, IconCopy } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { SpeakerAvatar } from "./meeting-aside.tsx";
import { initial, meetingSpeakers, UNKNOWN } from "./meeting-speakers.ts";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { SearchField, SearchInput } from "@/components/ui/search-field";
import { appToast } from "@/components/ui/toast";
import { useClipboard } from "@/hooks/use-clipboard.ts";
import { useMeetingTranscript, useMeetingWrites } from "@/hooks/use-meetings.ts";
import { meetingClock, type Meeting, type MeetingSegment } from "@/lib/meetings.ts";
import { usePlayer } from "./meeting-player.tsx";
import type { Speaker } from "./meeting-speakers.ts";

/** Each speaker's name, by the engine's label: the name given, else `Speaker N`. */
export function speakerNames(meeting: Meeting) {
  return new Map([...meetingSpeakers(meeting)].map(([label, s]) => [label, s.name]));
}

interface Turn {
  speaker: string | null;
  segments: MeetingSegment[];
}

function turns(segments: MeetingSegment[]) {
  const out: Turn[] = [];
  for (const segment of segments) {
    const last = out.at(-1);
    if (last && last.speaker === segment.speaker) last.segments.push(segment);
    else out.push({ speaker: segment.speaker, segments: [segment] });
  }
  return out;
}

const FIRST_TURNS = 30;

function wordAt(segment: MeetingSegment, words: string[], timeMs: number) {
  if (timeMs < segment.startMs || timeMs >= segment.endMs) return -1;
  const at = (timeMs - segment.startMs) / Math.max(1, segment.endMs - segment.startMs);
  return Math.min(words.length - 1, Math.floor(at * words.length));
}

/** Who said what, turn by turn: a face and a name to fix, then the words, the one playing lit. */
export function MeetingTranscript(props: { meeting: Meeting; canRename: boolean }) {
  const id = props.meeting.meeting.id;
  const transcript = useMeetingTranscript(id);
  const [query, setQuery] = useState("");
  const { copy, copied } = useClipboard();
  const player = usePlayer();
  const speakers = useMemo(() => meetingSpeakers(props.meeting), [props.meeting]);
  const speakerOf = (label: string | null) => speakers.get(label ?? "") ?? UNKNOWN;
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = transcript.data ?? [];
    return turns(needle ? all.filter((s) => s.text.toLowerCase().includes(needle)) : all);
  }, [transcript.data, query]);
  const drawn = useDeferredValue(shown, shown.slice(0, FIRST_TURNS));
  const text = () =>
    (transcript.data ?? [])
      .map((s) => `[${meetingClock(s.startMs)}] ${speakerOf(s.speaker).name}: ${s.text}`)
      .join("\n");
  return (
    <div className="flex flex-col gap-6">
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
        <ol className="flex flex-col gap-8">
          {drawn.map((turn) => (
            <TurnRow
              key={turn.segments[0]!.seq}
              turn={turn}
              speaker={speakerOf(turn.speaker)}
              meeting={props.meeting}
              canRename={props.canRename}
              playingSeq={playingSeq(turn, player.playing, player.timeMs)}
              hasAudio={player.hasAudio}
              seek={player.seek}
            />
          ))}
        </ol>
      </Skeleton>
    </div>
  );
}

function playingSeq(turn: Turn, playing: boolean, timeMs: number) {
  if (!playing) return -1;
  const first = turn.segments[0]!;
  const last = turn.segments.at(-1)!;
  if (timeMs < first.startMs || timeMs >= last.endMs) return -1;
  return turn.segments.find((s) => timeMs >= s.startMs && timeMs < s.endMs)?.seq ?? -1;
}

const TurnRow = memo(function TurnRow(props: {
  turn: Turn;
  speaker: Speaker;
  meeting: Meeting;
  canRename: boolean;
  playingSeq: number;
  hasAudio: boolean;
  seek: (ms: number) => void;
}) {
  const { turn, speaker } = props;
  return (
    <li className="flex flex-col gap-3">
      <div className="flex h-6 items-center gap-2">
        <SpeakerAvatar speaker={speaker} />
        {props.canRename && turn.speaker ? (
          <SpeakerMenu meeting={props.meeting} label={turn.speaker} name={speaker.name} />
        ) : (
          <span className="text-sm">{speaker.name}</span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {meetingClock(turn.segments[0]!.startMs)}
        </span>
      </div>
      <p className="text-sm/6 text-foreground">
        {turn.segments.map((segment) =>
          segment.seq === props.playingSeq ? (
            <PlayingSegment
              key={segment.seq}
              segment={segment}
              fill={speaker.fill}
              hasAudio={props.hasAudio}
              seek={props.seek}
            />
          ) : (
            <span
              key={segment.seq}
              className={props.hasAudio ? "cursor-pointer" : undefined}
              onPointerDown={() => props.hasAudio && props.seek(segment.startMs)}
            >
              {segment.text}{" "}
            </span>
          ),
        )}
      </p>
    </li>
  );
});

function PlayingSegment(props: {
  segment: MeetingSegment;
  fill: string;
  hasAudio: boolean;
  seek: (ms: number) => void;
}) {
  const player = usePlayer();
  const words = props.segment.text.split(/\s+/).filter(Boolean);
  const lit = player.playing ? wordAt(props.segment, words, player.timeMs) : -1;
  return (
    <span
      className={props.hasAudio ? "cursor-pointer" : undefined}
      onPointerDown={() => props.hasAudio && props.seek(props.segment.startMs)}
    >
      {words.map((word, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- a word's place is its identity
        <span key={i}>
          <span
            className={i === lit ? `rounded-sm px-0.5 -mx-0.5 text-white ${props.fill}` : undefined}
          >
            {word}
          </span>{" "}
        </span>
      ))}
    </span>
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
