import type { ReactNode } from "react";
import { IconPauseFilled, IconPlayFilled } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Slider, SliderTrack } from "@/components/ui/slider";
import { useMeetingTranscript, useMeetingWaveform } from "@/hooks/use-meetings.ts";
import { meetingClock, type Meeting } from "@/lib/meetings.ts";
import { usePlayer } from "./meeting-player.tsx";
import { initial, meetingSpeakers, talkLength, UNKNOWN, type Speaker } from "./meeting-speakers.ts";

/**
 * A panel card: 16px from its border to the nearest letters or control edges on every side. The
 * title's line box carries 3px over its capitals (Inter 13/16), so it starts 3px higher.
 */
export function Card(props: { title?: string; className?: string; children: ReactNode }) {
  return (
    <section
      className={`flex flex-col gap-3 rounded-xl border bg-background p-4 ${props.className ?? ""}`}
    >
      {props.title && (
        <h2 className="-mt-[3px] mb-1 text-sm leading-4 text-muted-foreground">{props.title}</h2>
      )}
      {props.children}
    </section>
  );
}

/** A label and its value in a panel card, the value against the card's right edge. */
export function DetailRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="group/property flex h-6 items-center gap-3">
      <span className="shrink-0 text-sm text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">{props.children}</div>
    </div>
  );
}

export function SpeakerAvatar({ speaker }: { speaker: Speaker }) {
  return (
    <Avatar
      initials={initial(speaker.name)}
      className={`${speaker.fill} text-white outline-0 [--avatar-size:--spacing(4)]`}
    />
  );
}

const BARS = 96;

interface Turn {
  seq: number;
  startMs: number;
  endMs: number;
}

function Track(props: {
  turns: (Turn & { fill: string })[];
  totalMs: number;
  atMs: number;
  className: string;
}) {
  const at = Math.min(1, props.atMs / props.totalMs) * 100;
  return (
    <div aria-hidden className={`relative rounded-full bg-secondary ${props.className}`}>
      {props.turns.map((t) => (
        <span
          key={t.seq}
          className={`absolute inset-y-0 rounded-full ${t.fill}`}
          style={{
            left: `${(t.startMs / props.totalMs) * 100}%`,
            width: `${Math.max(0.6, ((t.endMs - t.startMs) / props.totalMs) * 100)}%`,
          }}
        />
      ))}
      <span
        className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground"
        style={{ left: `calc(${at}% - ${at / 50}px)` }}
      />
    </div>
  );
}

function Waveform(props: { id: string; totalMs: number }) {
  const player = usePlayer();
  const wave = useMeetingWaveform(props.id);
  const at = player.timeMs / props.totalMs;
  const bars = wave.data ?? Array.from({ length: BARS }, () => 0.08);
  return (
    <div className="relative h-10 w-full rounded-md has-focus-visible:ring-2 has-focus-visible:ring-ring">
      <div aria-hidden className="flex size-full items-center gap-px">
        {bars.map((height, i) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- bars are positions, not items
            key={i}
            className={`min-w-0 flex-1 rounded-full ${i / bars.length < at ? "bg-foreground" : "bg-muted-foreground/30"}`}
            style={{ height: `${Math.max(6, height * 100)}%` }}
          />
        ))}
      </div>
      <Slider
        aria-label="Position"
        minValue={0}
        maxValue={props.totalMs}
        step={1000}
        value={Math.min(player.timeMs, props.totalMs)}
        onChange={(value) => player.seek(Array.isArray(value) ? (value[0] ?? 0) : value)}
        className="absolute! inset-0 opacity-0"
      >
        <SliderTrack className="h-full! cursor-pointer" />
      </Slider>
    </div>
  );
}

/** The recording: its sound to seek in, the fallback for a meeting with no video. */
export function RecordingCard({ meeting }: { meeting: Meeting }) {
  const player = usePlayer();
  if (!player.hasAudio) return null;
  const totalMs = Math.max(player.durationMs, meeting.meeting.durationMs ?? 0, 1);
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Waveform id={meeting.meeting.id} totalMs={totalMs} />
        <div className="flex h-3 items-center gap-1.5 text-xs leading-3 text-muted-foreground tabular-nums">
          <Button
            intent="plain"
            size="sq-2xs"
            aria-label={player.playing ? "Pause" : "Play"}
            onPress={player.toggle}
            className="-my-1.5 -ms-1 *:[svg]:size-3"
          >
            {player.playing ? <IconPauseFilled /> : <IconPlayFilled />}
          </Button>
          <span>{meetingClock(player.timeMs)}</span>
          <span className="ms-auto">{meetingClock(totalMs)}</span>
        </div>
      </div>
    </Card>
  );
}

/** Who spoke when: each speaker's own track, with their share of the talking. */
export function SpeakersCard({ meeting }: { meeting: Meeting }) {
  const player = usePlayer();
  const transcript = useMeetingTranscript(meeting.meeting.id);
  const speakers = meetingSpeakers(meeting);
  if (!meeting.talk.length) return null;
  const totalMs = Math.max(player.durationMs, meeting.meeting.durationMs ?? 0, 1);
  const turns = (transcript.data ?? []).map((s) => ({
    seq: s.seq,
    startMs: s.startMs,
    endMs: s.endMs,
    label: s.speaker ?? "",
    fill: (speakers.get(s.speaker ?? "") ?? UNKNOWN).fill,
  }));
  return (
    <Card>
      <ul className="flex flex-col gap-4">
        {meeting.talk.map((t) => {
          const speaker = speakers.get(t.label) ?? UNKNOWN;
          const own = turns.filter((turn) => turn.label === t.label);
          const next = own.find((turn) => turn.startMs > player.timeMs) ?? own[0];
          const speaking =
            player.playing &&
            own.some((turn) => turn.startMs <= player.timeMs && player.timeMs < turn.endMs);
          return (
            <li key={t.label} className="flex flex-col gap-3">
              <div className="flex h-5 items-center gap-2">
                <SpeakerAvatar speaker={speaker} />
                <span className="min-w-0 flex-1 truncate text-sm">{speaker.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {Math.round(t.share * 100)}% · {talkLength(t.ms)}
                </span>
                <Button
                  intent="plain"
                  size="sq-2xs"
                  isDisabled={!next}
                  aria-label={speaking ? "Pause" : `Play ${speaker.name}`}
                  onPress={() => (speaking ? player.toggle() : next && player.seek(next.startMs))}
                  className="-me-1 *:[svg]:size-3"
                >
                  {speaking ? <IconPauseFilled /> : <IconPlayFilled />}
                </Button>
              </div>
              <Track turns={own} totalMs={totalMs} atMs={player.timeMs} className="h-1" />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
