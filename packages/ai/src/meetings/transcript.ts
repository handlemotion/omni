/** One stretch of speech by one speaker. `speaker` is the engine's label, or null without labels. */
export interface Turn {
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

export interface EngineTranscript {
  /** ISO 639-1 when the engine detected it, else null. */
  language: string | null;
  durationMs: number;
  turns: Turn[];
  /** Names the engine gave its labels (AssemblyAI's speaker identification), by label. */
  engineNames: Record<string, string>;
}

export const TRANSCRIBE_PROVIDERS = ["assemblyai", "openai", "workers-ai"] as const;
export type TranscribeProvider = (typeof TRANSCRIBE_PROVIDERS)[number];

const SAME_TURN_GAP_MS = 2_000;
const LONGEST_TURN_MS = 90_000;

const EMPTY: Record<string, unknown> = {};
const NONE: unknown[] = [];
const record = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : EMPTY;
const list = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : NONE);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Joins same-speaker neighbours, drops empty turns and keeps them in time order. */
export function joinTurns(turns: Turn[]) {
  const sorted = turns
    .map((t) => ({ ...t, text: t.text.trim() }))
    .filter((t) => t.text)
    .toSorted((a, b) => a.startMs - b.startMs);
  const out: Turn[] = [];
  for (const turn of sorted) {
    const last = out.at(-1);
    const joins =
      last &&
      last.speaker === turn.speaker &&
      turn.startMs - last.endMs <= SAME_TURN_GAP_MS &&
      turn.endMs - last.startMs <= LONGEST_TURN_MS;
    if (joins) {
      last.text = `${last.text} ${turn.text}`;
      last.endMs = Math.max(last.endMs, turn.endMs);
    } else out.push({ ...turn });
  }
  return out;
}

const ASSEMBLYAI_LETTER_LABEL = /^[A-Z]{1,2}$/;

/**
 * An AssemblyAI `/v2/transcript/:id` result (times in ms, `audio_duration` in seconds). When
 * speaker identification replaced a label with a name, the name becomes the label and is kept in
 * `engineNames`, so a later rename still works on one stable key.
 */
export function fromAssemblyAI(json: unknown) {
  const body = record(json);
  const engineNames: Record<string, string> = {};
  const mapping = record(
    record(record(record(body.speech_understanding).response).speaker_identification).mapping,
  );
  for (const [label, name] of Object.entries(mapping)) {
    if (typeof name === "string" && name.trim()) engineNames[label] = name.trim();
  }
  const turns = list(body.utterances).map((u) => {
    const utterance = record(u);
    const speaker = str(utterance.speaker).trim() || null;
    if (speaker && !ASSEMBLYAI_LETTER_LABEL.test(speaker)) engineNames[speaker] = speaker;
    return {
      speaker,
      startMs: Math.round(num(utterance.start)),
      endMs: Math.round(num(utterance.end)),
      text: str(utterance.text),
    };
  });
  return {
    language: languageOf(body.language_code),
    durationMs: Math.round(num(body.audio_duration) * 1000),
    turns: joinTurns(turns),
    engineNames,
  } satisfies EngineTranscript;
}

/**
 * An OpenAI-compatible `/audio/transcriptions` result: `verbose_json` (segments, no speakers),
 * `diarized_json` (segments with `speaker`), or a WhisperX server's. Times in seconds.
 */
export function fromOpenAI(json: unknown) {
  const body = record(json);
  const segments = list(body.segments).map((s) => record(s));
  const turns = segments.map((segment) => ({
    speaker: str(segment.speaker).trim() || null,
    startMs: Math.round(num(segment.start) * 1000),
    endMs: Math.round(num(segment.end) * 1000),
    text: str(segment.text),
  }));
  const lastEnd = turns.reduce((max, t) => Math.max(max, t.endMs), 0);
  return {
    language: languageOf(body.language),
    durationMs: body.duration === undefined ? lastEnd : Math.round(num(body.duration) * 1000),
    turns: joinTurns(turns),
    engineNames: {},
  } satisfies EngineTranscript;
}

/** Workers AI `@cf/openai/whisper-large-v3-turbo`: segments in seconds, no speakers. */
export function fromWorkersAI(json: unknown) {
  const body = record(json);
  const info = record(body.transcription_info);
  const turns = list(body.segments).map((s) => {
    const segment = record(s);
    return {
      speaker: null,
      startMs: Math.round(num(segment.start) * 1000),
      endMs: Math.round(num(segment.end) * 1000),
      text: str(segment.text),
    };
  });
  return {
    language: languageOf(info.language),
    durationMs: Math.round(num(info.duration) * 1000),
    turns: joinTurns(turns),
    engineNames: {},
  } satisfies EngineTranscript;
}

export function normalizeTranscript(provider: TranscribeProvider, json: unknown) {
  if (provider === "assemblyai") return fromAssemblyAI(json);
  if (provider === "openai") return fromOpenAI(json);
  return fromWorkersAI(json);
}

const WHISPER_LANGUAGE_NAMES: Record<string, string> = {
  english: "en",
  spanish: "es",
  portuguese: "pt",
  french: "fr",
  german: "de",
  italian: "it",
  catalan: "ca",
  dutch: "nl",
};

function languageOf(value: unknown) {
  const raw = str(value).trim().toLowerCase();
  if (!raw) return null;
  if (WHISPER_LANGUAGE_NAMES[raw]) return WHISPER_LANGUAGE_NAMES[raw];
  const code = raw.split(/[-_]/)[0] ?? "";
  return /^[a-z]{2}$/.test(code) ? code : null;
}
