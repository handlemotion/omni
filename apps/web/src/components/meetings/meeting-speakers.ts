import type { Meeting } from "@/lib/meetings.ts";

const FILLS = [
  "bg-speaker-1",
  "bg-speaker-2",
  "bg-speaker-3",
  "bg-speaker-4",
  "bg-speaker-5",
  "bg-speaker-6",
] as const;

export interface Speaker {
  label: string;
  name: string;
  /** The speaker's fill: their avatar, their bars on the timeline, their word as it plays. */
  fill: (typeof FILLS)[number];
}

/** Each speaker by the engine's label, in the meeting's order: a name and a colour of their own. */
export function meetingSpeakers(meeting: Meeting) {
  return new Map<string, Speaker>(
    meeting.speakers.map((s, i) => [
      s.label,
      { label: s.label, name: s.name ?? `Speaker ${i + 1}`, fill: FILLS[i % FILLS.length]! },
    ]),
  );
}

export const UNKNOWN: Speaker = { label: "", name: "Unknown", fill: FILLS[0] };

export const initial = (name: string) => name.trim().slice(0, 1).toUpperCase();

/** `1m`, `57s`, `1h 5m`: how long someone talked. */
export function talkLength(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
