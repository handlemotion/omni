import type { Turn } from "./transcript.ts";

/** A stretch of the meeting's clock, in ms. */
export interface Span {
  startMs: number;
  endMs: number;
}

/** Someone invited to the meeting, or the person who recorded it. */
export interface Person {
  address: string;
  name: string | null;
}

export type SpeakerSource = "mic" | "engine" | "ai" | "person";

export interface ResolvedSpeaker {
  label: string;
  name: string | null;
  address: string | null;
  source: SpeakerSource | null;
  confidence: number;
}

export interface ResolveSpeakersInput {
  turns: Turn[];
  /** When the recorder's mic carried speech and the computer's sound did not; null in a browser that could not tell. */
  micSpans: Span[] | null;
  recorder: Person;
  attendees: Person[];
  /** Names the engine gave its labels. */
  engineNames: Record<string, string>;
}

/** Share of a speaker's talk that must fall in the mic's spans for them to be the recorder. */
export const MIC_SHARE = 0.6;

const overlap = (a: Span, b: Span) =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The engine's labels in the order they first speak. */
export function labelsOf(turns: Turn[]) {
  const seen = new Set<string>();
  for (const turn of turns) if (turn.speaker) seen.add(turn.speaker);
  return [...seen];
}

function talkTime(turns: Turn[], micSpans: Span[]) {
  const time = new Map<string, { total: number; onMic: number }>();
  for (const turn of turns) {
    if (!turn.speaker) continue;
    const entry = time.get(turn.speaker) ?? { total: 0, onMic: 0 };
    entry.total += Math.max(0, turn.endMs - turn.startMs);
    for (const span of micSpans) entry.onMic += overlap(turn, span);
    time.set(turn.speaker, entry);
  }
  return time;
}

/** The label whose talk the mic carried most, when at least `MIC_SHARE` of it; else null. */
export function recorderLabel(turns: Turn[], micSpans: Span[] | null) {
  if (!micSpans?.length) return null;
  let best: { label: string; onMic: number; share: number } | null = null;
  for (const [label, { total, onMic }] of talkTime(turns, micSpans)) {
    if (!total || (best && onMic <= best.onMic)) continue;
    best = { label, onMic, share: onMic / total };
  }
  return best && best.share >= MIC_SHARE ? best : null;
}

/** The one person `name` points at among `people`: full name, else a unique first name. */
export function matchPerson(name: string, people: Person[]) {
  const wanted = fold(name);
  if (!wanted) return null;
  const full = people.filter((p) => p.name && fold(p.name) === wanted);
  if (full.length === 1) return full[0] ?? null;
  const first = wanted.split(" ")[0];
  const byFirst = people.filter((p) => p.name && fold(p.name).split(" ")[0] === first);
  if (byFirst.length === 1) return byFirst[0] ?? null;
  const byAddress = people.filter((p) => fold(p.address.split("@")[0] ?? "") === wanted);
  return byAddress.length === 1 ? (byAddress[0] ?? null) : null;
}

/**
 * Steps 1 and 2 of the spec's "Speakers": the recorder from their mic, the other person in a
 * two-person call, then the engine's names matched to attendees. Labels left unnamed go to the
 * names pass (`nameSpeakers`), then to a person.
 */
export function resolveSpeakers(input: ResolveSpeakersInput) {
  const labels = labelsOf(input.turns);
  const resolved = new Map<string, ResolvedSpeaker>(
    labels.map((label) => [
      label,
      { label, name: null, address: null, source: null, confidence: 0 },
    ]),
  );
  const taken = new Set<string>();
  const assign = (label: string, person: Person, source: SpeakerSource, confidence: number) => {
    resolved.set(label, {
      label,
      name: person.name ?? person.address,
      address: person.address,
      source,
      confidence,
    });
    taken.add(fold(person.address));
  };

  const mic = recorderLabel(input.turns, input.micSpans);
  if (mic) assign(mic.label, input.recorder, "mic", mic.share);

  const others = input.attendees.filter((p) => fold(p.address) !== fold(input.recorder.address));
  const [other] = others;
  if (mic && labels.length === 2 && others.length === 1 && other) {
    const label = labels.find((l) => l !== mic.label);
    if (label) assign(label, other, "mic", mic.share);
  }

  const people = [input.recorder, ...others];
  for (const label of labels) {
    const current = resolved.get(label);
    const engineName = input.engineNames[label];
    if (current?.source || !engineName) continue;
    const person = matchPerson(engineName, people);
    if (person && taken.has(fold(person.address))) continue;
    if (person) assign(label, person, "engine", 0.8);
    else
      resolved.set(label, {
        label,
        name: engineName,
        address: null,
        source: "engine",
        confidence: 0.6,
      });
  }

  return labels.map((label) => resolved.get(label)).filter((s) => s !== undefined);
}

/** What a reader sees for a speaker: their name, else `Speaker N` by order of first speech. */
export function speakerTitles(speakers: ResolvedSpeaker[]) {
  return new Map(speakers.map((s, i) => [s.label, s.name ?? `Speaker ${i + 1}`]));
}
