import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { IconPauseFilled, IconPlayFilled } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useMeetingTranscript } from "@/hooks/use-meetings.ts";
import { meetingAudioUrl, meetingClock, type Meeting } from "@/lib/meetings.ts";
import { usePlayer } from "./meeting-player.tsx";
import { initial, meetingSpeakers, talkLength, UNKNOWN, type Speaker } from "./meeting-speakers.ts";

const BARS = 96;

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
        <h2 className="-mt-[3px] text-sm leading-4 text-muted-foreground">{props.title}</h2>
      )}
      {props.children}
    </section>
  );
}

/** Who spoke and how much, longest first. */
export function PeopleCard({ meeting }: { meeting: Meeting }) {
  const speakers = meetingSpeakers(meeting);
  if (!meeting.talk.length) return null;
  return (
    <Card title="People">
      <ul className="flex flex-col gap-3">
        {meeting.talk.map((t) => {
          const speaker = speakers.get(t.label) ?? UNKNOWN;
          return (
            <li key={t.label} className="flex h-5 items-center gap-2">
              <SpeakerAvatar speaker={speaker} />
              <span className="min-w-0 flex-1 truncate text-sm">{speaker.name}</span>
              <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-secondary">
                <span
                  className={`block h-full rounded-full ${speaker.fill}`}
                  style={{ width: `${Math.max(4, t.share * 100)}%` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
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

async function peaks(url: string) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`audio ${response.status}`);
  const context = new OfflineAudioContext(1, 1, 48_000);
  const audio = await context.decodeAudioData(await response.arrayBuffer());
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  const step = Math.max(1, Math.floor(audio.length / BARS));
  const out: number[] = [];
  for (let bar = 0; bar < BARS; bar++) {
    let peak = 0;
    for (const data of channels) {
      for (let i = bar * step; i < Math.min((bar + 1) * step, data.length); i += 16) {
        peak = Math.max(peak, Math.abs(data[i] ?? 0));
      }
    }
    out.push(peak);
  }
  const top = Math.max(...out, 0.0001);
  return out.map((p) => p / top);
}

function Waveform({ id }: { id: string }) {
  const player = usePlayer();
  const wave = useQuery({
    queryKey: ["meetings", "waveform", id],
    queryFn: () => peaks(meetingAudioUrl(id)),
    staleTime: Infinity,
    retry: false,
  });
  const at = player.durationMs ? player.timeMs / player.durationMs : 0;
  const bars = wave.data ?? Array.from({ length: BARS }, () => 0.08);
  return (
    <div
      aria-hidden
      className="flex h-16 w-full cursor-pointer items-center gap-px"
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        player.seek(((event.clientX - box.left) / box.width) * player.durationMs);
      }}
    >
      {bars.map((height, i) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- bars are positions, not items
          key={i}
          className={`min-w-0 flex-1 rounded-full ${i / BARS < at ? "bg-foreground" : "bg-muted-foreground/30"}`}
          style={{ height: `${Math.max(6, height * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** The recording: its waveform to seek in, play, and where in the meeting it is. */
export function PlaybackCard({ meeting }: { meeting: Meeting }) {
  const player = usePlayer();
  if (!player.hasAudio) return null;
  return (
    <Card>
      <Waveform id={meeting.meeting.id} />
      <div className="flex h-6 items-center gap-2">
        <Button
          intent="secondary"
          size="sq-xs"
          aria-label={player.playing ? "Pause" : "Play"}
          onPress={player.toggle}
        >
          {player.playing ? <IconPauseFilled /> : <IconPlayFilled />}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {meetingClock(player.timeMs)} / {meetingClock(player.durationMs)}
        </span>
      </div>
    </Card>
  );
}

/** When each person spoke, one track per speaker; pressing a turn plays it. */
export function TimelineCard({ meeting }: { meeting: Meeting }) {
  const player = usePlayer();
  const transcript = useMeetingTranscript(meeting.meeting.id);
  const speakers = meetingSpeakers(meeting);
  const total = Math.max(player.durationMs, meeting.meeting.durationMs ?? 0, 1);
  const segments = transcript.data ?? [];
  if (!meeting.talk.length) return null;
  const at = Math.min(1, player.timeMs / total) * 100;
  return (
    <Card title="Timeline">
      <ul className="flex flex-col gap-4">
        {meeting.talk.map((t) => {
          const speaker = speakers.get(t.label) ?? UNKNOWN;
          const turns = segments.filter((s) => s.speaker === t.label);
          const next = turns.find((s) => s.startMs > player.timeMs) ?? turns[0];
          return (
            <li key={t.label} className="flex flex-col gap-2">
              <div className="flex h-5 items-center gap-2">
                <Button
                  intent="plain"
                  size="sq-xs"
                  isDisabled={!player.hasAudio || !next}
                  aria-label={`Play ${speaker.name}`}
                  onPress={() => next && player.seek(next.startMs)}
                  className="-ms-1.5 -me-0.5 size-5"
                >
                  <IconPlayFilled />
                </Button>
                <span className="min-w-0 flex-1 truncate text-sm">{speaker.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {Math.round(t.share * 100)}% · {talkLength(t.ms)}
                </span>
              </div>
              <div className="relative h-1.5 rounded-full bg-secondary">
                {turns.map((s) => (
                  <span
                    key={s.seq}
                    className={`absolute inset-y-0 rounded-full ${speaker.fill}`}
                    style={{
                      left: `${(s.startMs / total) * 100}%`,
                      width: `${Math.max(0.5, ((s.endMs - s.startMs) / total) * 100)}%`,
                    }}
                  />
                ))}
                <span
                  aria-hidden
                  className="absolute -inset-y-1 w-px bg-foreground"
                  style={{ left: `${at}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
