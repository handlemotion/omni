import type { Span } from "./speakers.ts";
import type { EngineTranscript, Turn } from "./transcript.ts";

/** A silence the recorder left out: at `atMs` of the uploaded audio, `droppedMs` of the meeting were skipped. */
export interface Cut {
  atMs: number;
  droppedMs: number;
}

/** A time in the uploaded audio, put back on the meeting's clock. `cuts` in any order. */
export function meetingTime(audioMs: number, cuts: Cut[]) {
  let shift = 0;
  for (const cut of cuts) if (cut.atMs <= audioMs) shift += cut.droppedMs;
  return audioMs + shift;
}

/** Turns and mic spans on the meeting's clock, after the recorder dropped silences. */
export function restoreTimes<T extends Span>(items: T[], cuts: Cut[]) {
  if (!cuts.length) return items;
  return items.map((item) => ({
    ...item,
    startMs: meetingTime(item.startMs, cuts),
    endMs: meetingTime(item.endMs, cuts),
  }));
}

/**
 * A meeting recorded in parts (the first recorder stopped, someone else went on): each part's
 * turns moved by where the part started on the meeting's clock, then joined in order. Labels are
 * prefixed with the part (`2:A`), because engines label each file on its own.
 */
export function joinParts(parts: Array<{ startMs: number; transcript: EngineTranscript }>) {
  const ordered = parts.toSorted((a, b) => a.startMs - b.startMs);
  const turns: Turn[] = [];
  const engineNames: Record<string, string> = {};
  let durationMs = 0;
  ordered.forEach(({ startMs, transcript }, index) => {
    const prefix = (label: string) => (index === 0 ? label : `${index + 1}:${label}`);
    for (const turn of transcript.turns) {
      turns.push({
        ...turn,
        speaker: turn.speaker === null ? null : prefix(turn.speaker),
        startMs: turn.startMs + startMs,
        endMs: turn.endMs + startMs,
      });
    }
    for (const [label, name] of Object.entries(transcript.engineNames)) {
      engineNames[prefix(label)] = name;
    }
    durationMs = Math.max(durationMs, startMs + transcript.durationMs);
  });
  return {
    language: ordered[0]?.transcript.language ?? null,
    durationMs,
    turns,
    engineNames,
  } satisfies EngineTranscript;
}
