import type { MeetingChunksResponse, StopMeetingBody } from "@omni/contracts";
import { ERROR_FORMAT_HEADER, ERROR_FORMAT_VERSION, toApiError } from "@omni/contracts/errors";
import { RecordingUploadError, type RecordingTransport } from "./recordings.ts";

/** One chunk of a browser recording as it waits on the computer. */
export interface SpooledChunk {
  seq: number;
  /** SHA-256 of `bytes`, lowercase hex. */
  sha256: string;
  /** Where the chunk ends on the recording's clock. */
  endMs: number;
  bytes: Uint8Array;
}

/** How a recording ended on the computer, once its recorder stopped it. */
export interface SpooledStop {
  chunks: number;
  durationMs: number;
  micSpans: StopMeetingBody["micSpans"];
}

/**
 * Where a browser recording waits until the server has all of it (IndexedDB in the web app). A
 * chunk stays until the meeting is stopped whole, so one the server says is missing is sent again.
 */
export interface ChunkSpool {
  /** The chunks the server has not acknowledged yet, in order. */
  unsent(meetingId: string): Promise<SpooledChunk[]>;
  acknowledged(meetingId: string, seq: number): Promise<void>;
  /** The server is missing these after all: send them again. */
  resend(meetingId: string, seqs: number[]): Promise<void>;
  /** The recorder's stop, or null while it still records. */
  stopped(meetingId: string): Promise<SpooledStop | null>;
  /** Deletes the recording from the computer. */
  discard(meetingId: string): Promise<void>;
}

/**
 * `finished`: the meeting has every chunk and its pipeline started. `meeting_gone`: it was
 * deleted. `closed`: the server stopped taking chunks for it (the sweep stopped it after its
 * recorder was away for hours), so what arrived is what is transcribed.
 */
export type ChunkedOutcome = "finished" | "meeting_gone" | "closed";

/** What the recorder shows while it sends: how much waits, and since when nothing went through. */
export interface SendingState {
  waiting: number;
  /** When the last chunk was acknowledged (or sending began), in ms since the epoch. */
  lastAckAt: number;
  /** The failure that is being waited out, or null. */
  failing: string | null;
}

export interface DrainOptions {
  /** Waits before the next try; resolves early when the caller knows the network is back. */
  wait?: (ms: number) => Promise<void>;
  onState?: (state: SendingState) => void;
  /** How long to wait for the next chunk while the recording is still going. */
  idleMs?: number;
  random?: () => number;
}

/** No retry waits longer than this. */
export const CHUNK_RETRY_MAX_MS = 60_000;
/** After this long with nothing acknowledged, the recorder shows it is offline. */
export const OFFLINE_AFTER_MS = 2 * 60_000;

/** The wait before try `attempt + 1`: 1 second, doubling to a minute, with up to a fifth more. */
export function chunkRetryMs(attempt: number, random = Math.random()) {
  const base = Math.min(1000 * 2 ** attempt, CHUNK_RETRY_MAX_MS);
  return Math.round(base * (1 + random / 5));
}

type Answer = { status: number; ok: boolean; json: unknown };

async function send(
  transport: RecordingTransport,
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
) {
  const response = await (transport.fetch ?? fetch)(new URL(`/api${path}`, transport.baseUrl), {
    method,
    credentials: "include",
    headers: { [ERROR_FORMAT_HEADER]: ERROR_FORMAT_VERSION, ...init.headers, ...transport.headers },
    body: init.body,
  });
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : null;
  return { status: response.status, ok: response.ok, json } satisfies Answer;
}

const passing = (status: number) =>
  status === 0 || status === 408 || status === 422 || status === 429 || status >= 500;

const failure = (answer: Answer, what: string) =>
  new RecordingUploadError(
    answer.status,
    toApiError(answer.json, `${what} failed (${answer.status})`),
  );

const reasonOf = (answer: Answer) => toApiError(answer.json, "").details?.reason;

async function attempt(run: () => Promise<Answer>) {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "the network failed";
    return { status: 0, ok: false, json: { error: { code: "network", message } } } satisfies Answer;
  }
}

async function sendChunk(transport: RecordingTransport, meetingId: string, chunk: SpooledChunk) {
  const answer = await attempt(() =>
    send(transport, "PUT", `/meetings/${meetingId}/chunks/${chunk.seq}?endMs=${chunk.endMs}`, {
      body: new Blob([new Uint8Array(chunk.bytes)]),
      headers: {
        "content-type": "application/octet-stream",
        "x-content-sha256": chunk.sha256,
      },
    }),
  );
  if (answer.ok) return "sent" as const;
  if (answer.status === 404) return "meeting_gone" as const;
  if (answer.status === 409) {
    return reasonOf(answer) === "chunk_conflict" ? ("sent" as const) : ("closed" as const);
  }
  if (passing(answer.status)) return answer;
  throw failure(answer, `sending chunk ${chunk.seq}`);
}

async function stopWhole(transport: RecordingTransport, meetingId: string, stop: SpooledStop) {
  const answer = await attempt(() =>
    send(transport, "POST", `/meetings/${meetingId}/stop`, {
      body: JSON.stringify({ ...stop, cuts: [] } satisfies StopMeetingBody),
      headers: { "content-type": "application/json" },
    }),
  );
  if (answer.ok) return { kind: "finished" as const };
  if (answer.status === 404) return { kind: "meeting_gone" as const };
  if (answer.status === 409 && reasonOf(answer) === "missing_chunks") {
    const details = toApiError(answer.json, "").details as { missing?: number[] } | undefined;
    return { kind: "missing" as const, seqs: details?.missing ?? [] };
  }
  if (answer.status === 409) return { kind: "closed" as const };
  if (passing(answer.status)) return { kind: "retry" as const, answer };
  throw failure(answer, "stopping the meeting");
}

/** The chunks the server holds for a meeting, or null when it is gone. */
export async function serverChunks(transport: RecordingTransport, meetingId: string) {
  const answer = await send(transport, "GET", `/meetings/${meetingId}/chunks`);
  if (answer.status === 404) return null;
  if (!answer.ok) throw failure(answer, "reading the chunks");
  return answer.json as MeetingChunksResponse;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends a browser recording's chunks until the server has all of them, then stops the meeting
 * with them and deletes the recording from the computer. Run it while recording (it waits for
 * new chunks), and again after a reload or a crash: it carries on from what the spool still
 * holds. A chunk that fails is tried again after a capped, growing wait, for as long as it
 * takes; only an answer no retry can change (the meeting is gone, or no longer recording) ends
 * it early. Anything else unexpected throws `RecordingUploadError` and keeps the spool.
 */
export async function drainRecording(
  transport: RecordingTransport,
  spool: ChunkSpool,
  meetingId: string,
  options: DrainOptions = {},
) {
  const wait = options.wait ?? sleep;
  const random = options.random ?? Math.random;
  let lastAckAt = Date.now();
  let failures = 0;
  const report = (waiting: number, failing: string | null) =>
    options.onState?.({ waiting, lastAckAt, failing });
  const backOff = async (answer: Answer, waiting: number) => {
    report(waiting, toApiError(answer.json, "the server did not answer").message);
    await wait(chunkRetryMs(failures++, random()));
  };
  const end = async (outcome: ChunkedOutcome) => {
    await spool.discard(meetingId);
    report(0, null);
    return outcome;
  };
  for (;;) {
    const unsent = await spool.unsent(meetingId);
    report(unsent.length, null);
    let progressed = true;
    for (const chunk of unsent) {
      const sent = await sendChunk(transport, meetingId, chunk);
      if (sent === "meeting_gone" || sent === "closed") return end(sent);
      if (sent !== "sent") {
        await backOff(sent, unsent.length);
        progressed = false;
        break;
      }
      await spool.acknowledged(meetingId, chunk.seq);
      lastAckAt = Date.now();
      failures = 0;
    }
    if (!progressed) continue;
    const stop = await spool.stopped(meetingId);
    if (!stop) {
      await wait(options.idleMs ?? 1000);
      continue;
    }
    if ((await spool.unsent(meetingId)).length) continue;
    const stopped = await stopWhole(transport, meetingId, stop);
    if (stopped.kind === "missing") {
      await spool.resend(meetingId, stopped.seqs);
      continue;
    }
    if (stopped.kind === "retry") {
      await backOff(stopped.answer, 0);
      continue;
    }
    return end(stopped.kind);
  }
}
