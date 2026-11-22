import type { TranscribeProvider } from "@omni/ai";

/** What the engine is told about the meeting, so it can label and name speakers. */
export interface EngineHints {
  /** Attendee names, for speaker identification and as key terms. */
  names: string[];
  /** Companies, the deal's name: words the engine should spell right. */
  terms: string[];
  /** How many people could be speaking: 2 to attendees + 1. */
  maxSpeakers: number;
}

export interface EngineAudio {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
}

/** An engine either answers at once (`result`) or gives a job to poll. */
export type Submitted = { jobId: string } | { result: unknown };
export type Polled =
  | { state: "pending" }
  | { state: "done"; result: unknown }
  | { state: "error"; error: string };

export interface Engine {
  provider: TranscribeProvider;
  submit: (audio: EngineAudio, hints: EngineHints) => Promise<Submitted>;
  poll: (jobId: string) => Promise<Polled>;
  /** Asks the engine to forget the audio and transcript once Omni has saved them. */
  forget: (jobId: string) => Promise<void>;
}

export interface EngineConfig {
  provider: TranscribeProvider | "none";
  url: string | undefined;
  model: string | undefined;
  apiKey: string | undefined;
  ai: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> } | undefined;
}

export class EngineError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const ASSEMBLYAI_URL = "https://api.assemblyai.com";
const WORKERS_AI_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** Workers AI takes the audio inline as base64; past this it is refused, not cut. */
export const WORKERS_AI_MAX_BYTES = 20 * 1024 * 1024;

async function checked(response: Response, what: string) {
  if (response.ok) return response;
  const retryable = response.status === 429 || response.status >= 500;
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  throw new EngineError(`${what}: ${response.status} ${detail}`, retryable);
}

function assemblyAI(config: EngineConfig) {
  const base = (config.url ?? ASSEMBLYAI_URL).replace(/\/$/, "");
  const headers = { authorization: config.apiKey ?? "" };
  const engine: Engine = {
    provider: "assemblyai",
    async submit(audio, hints) {
      const uploaded = await checked(
        await fetch(`${base}/v2/upload`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/octet-stream",
            "content-length": String(audio.size),
          },
          body: audio.body,
        }),
        "AssemblyAI upload",
      );
      const { upload_url: audioUrl } = (await uploaded.json()) as { upload_url: string };
      const names = [...new Set(hints.names.filter(Boolean))].slice(0, 50);
      const body: Record<string, unknown> = {
        audio_url: audioUrl,
        language_detection: true,
        speaker_labels: true,
        speaker_options: {
          min_speakers_expected: 1,
          max_speakers_expected: Math.max(2, hints.maxSpeakers),
        },
        keyterms_prompt: [...new Set([...names, ...hints.terms])].slice(0, 100),
      };
      if (config.model) body.speech_models = [config.model];
      if (names.length) {
        body.speech_understanding = {
          request: { speaker_identification: { speaker_type: "name", known_values: names } },
        };
      }
      const submitted = await checked(
        await fetch(`${base}/v2/transcript`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        "AssemblyAI submit",
      );
      return { jobId: ((await submitted.json()) as { id: string }).id };
    },
    async poll(jobId) {
      const response = await checked(
        await fetch(`${base}/v2/transcript/${encodeURIComponent(jobId)}`, { headers }),
        "AssemblyAI poll",
      );
      const json = (await response.json()) as { status: string; error?: string };
      if (json.status === "completed") return { state: "done", result: json };
      if (json.status === "error")
        return { state: "error", error: json.error ?? "transcription failed" };
      return { state: "pending" };
    },
    async forget(jobId) {
      await fetch(`${base}/v2/transcript/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
        headers,
      });
    },
  };
  return engine;
}

function openAICompatible(config: EngineConfig) {
  const base = (config.url ?? "").replace(/\/$/, "");
  const engine: Engine = {
    provider: "openai",
    async submit(audio) {
      const form = new FormData();
      const bytes = await new Response(audio.body).blob();
      form.append("file", new File([bytes], "meeting.ogg", { type: audio.contentType }));
      form.append("model", config.model ?? "whisper-1");
      form.append("response_format", "verbose_json");
      const response = await checked(
        await fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
          body: form,
        }),
        "Transcription server",
      );
      return { result: await response.json() };
    },
    poll: async () => ({ state: "error", error: "this engine has no jobs" }),
    forget: async () => {},
  };
  return engine;
}

function workersAI(config: EngineConfig) {
  const engine: Engine = {
    provider: "workers-ai",
    async submit(audio) {
      if (!config.ai) throw new EngineError("the AI binding is missing", false);
      if (audio.size > WORKERS_AI_MAX_BYTES) {
        throw new EngineError("the recording is too long for Workers AI", false);
      }
      const bytes = new Uint8Array(await new Response(audio.body).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const result = await config.ai.run(WORKERS_AI_MODEL, {
        audio: btoa(binary),
        vad_filter: true,
      });
      return { result };
    },
    poll: async () => ({ state: "error", error: "this engine has no jobs" }),
    forget: async () => {},
  };
  return engine;
}

/** The engine `TRANSCRIBE_PROVIDER` names, or null when Meetings is off. */
export function engineFor(config: EngineConfig) {
  if (config.provider === "assemblyai") return assemblyAI(config);
  if (config.provider === "openai") return openAICompatible(config);
  if (config.provider === "workers-ai") return workersAI(config);
  return null;
}
