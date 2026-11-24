import type { ReactNode } from "react";
import {
  IconFastForward5s,
  IconPauseFilled,
  IconPlayFilled,
  IconRewind5s,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Slider, SliderTrack } from "@/components/ui/slider";
import { useMeetingTranscript } from "@/hooks/use-meetings.ts";
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

export function SpeakerAvatar({ speaker }: { speaker: Speaker }) {
  return (
    <Avatar
      size="xs"
      initials={initial(speaker.name)}
      className={`${speaker.fill} text-white outline-0`}
    />
  );
}

const RATES = [1, 1.25, 1.5, 2];
const SKIP_MS = 5000;

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
        className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
        style={{ left: `${at}%` }}
      />
    </div>
  );
}

/**
 * The recording, one card: every turn on one track to seek in, the controls, then each speaker's
 * own track with their share of the talking.
 */
export function RecordingCard({ meeting }: { meeting: Meeting }) {
  const player = usePlayer();
  const transcript = useMeetingTranscript(meeting.meeting.id);
  const speakers = meetingSpeakers(meeting);
  if (!player.hasAudio) return null;
  const totalMs = Math.max(player.durationMs, meeting.meeting.durationMs ?? 0, 1);
  const turns = (transcript.data ?? []).map((s) => ({
    seq: s.seq,
    startMs: s.startMs,
    endMs: s.endMs,
    label: s.speaker ?? "",
    fill: (speakers.get(s.speaker ?? "") ?? UNKNOWN).fill,
  }));
  const nextRate = RATES[(RATES.indexOf(player.rate) + 1) % RATES.length] ?? 1;
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <div className="relative py-1">
          <Track turns={turns} totalMs={totalMs} atMs={player.timeMs} className="h-2" />
          <Slider
            aria-label="Position"
            minValue={0}
            maxValue={totalMs}
            step={1000}
            value={Math.min(player.timeMs, totalMs)}
            onChange={(value) => player.seek(Array.isArray(value) ? (value[0] ?? 0) : value)}
            className="absolute! inset-0 opacity-0"
          >
            <SliderTrack className="h-full! cursor-pointer" />
          </Slider>
        </div>
        <div className="flex justify-between text-xs leading-3 text-muted-foreground tabular-nums">
          <span>{meetingClock(player.timeMs)}</span>
          <span>−{meetingClock(Math.max(0, totalMs - player.timeMs))}</span>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <Button
          intent="plain"
          size="sm"
          aria-label={`Speed ${player.rate}×, change to ${nextRate}×`}
          onPress={() => player.setRate(nextRate)}
          className="-ms-2 justify-self-start text-sm tabular-nums"
        >
          {player.rate}×
        </Button>
        <div className="flex items-center gap-2">
          <Button
            intent="plain"
            size="sq-md"
            isCircle
            aria-label="Back 5 seconds"
            onPress={() => player.seek(Math.max(0, player.timeMs - SKIP_MS))}
          >
            <IconRewind5s />
          </Button>
          <Button
            intent="primary"
            size="sq-lg"
            isCircle
            aria-label={player.playing ? "Pause" : "Play"}
            onPress={player.toggle}
          >
            {player.playing ? <IconPauseFilled /> : <IconPlayFilled />}
          </Button>
          <Button
            intent="plain"
            size="sq-md"
            isCircle
            aria-label="Forward 5 seconds"
            onPress={() => player.seek(Math.min(totalMs, player.timeMs + SKIP_MS))}
          >
            <IconFastForward5s />
          </Button>
        </div>
      </div>
      {meeting.talk.length > 0 && (
        <ul className="mt-1 flex flex-col gap-4 border-t pt-4">
          {meeting.talk.map((t) => {
            const speaker = speakers.get(t.label) ?? UNKNOWN;
            const own = turns.filter((turn) => turn.label === t.label);
            const next = own.find((turn) => turn.startMs > player.timeMs) ?? own[0];
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
                    aria-label={`Play ${speaker.name}`}
                    onPress={() => next && player.seek(next.startMs)}
                    className="-me-1 *:[svg]:size-3"
                  >
                    <IconPlayFilled />
                  </Button>
                </div>
                <Track turns={own} totalMs={totalMs} atMs={player.timeMs} className="h-1" />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
