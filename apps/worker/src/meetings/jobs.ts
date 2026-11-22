import Anthropic from "@anthropic-ai/sdk";
import {
  AI_MODEL,
  nameSpeakers,
  normalizeTranscript,
  NOTES_PROMPT_VERSION,
  resolveSpeakers,
  restoreTimes,
  speakerTitles,
  writeNotes,
  type ResolvedSpeaker,
  type Usage,
} from "@omni/ai";
import { meetingsPipeline, storageWorkspaceFile, type Db, type MeetingStatus } from "@omni/db";
import type { Config } from "../env.ts";
import type { Logger } from "../log.ts";
import { enqueueNotesDoc } from "./doc.ts";
import { engineFor, EngineError, type Engine, type EngineConfig } from "./engines.ts";

export const MEETING_STEPS = ["transcribe", "poll", "name", "write"] as const;
export type MeetingStep = (typeof MEETING_STEPS)[number];

/** A step of one meeting's pipeline. Ids only. */
export type MeetingJob = {
  kind: "meeting";
  meetingId: string;
  orgId: string;
  step: MeetingStep;
  requestId?: string;
};

/** What a step asks the queue to do next, and what it spent on the model. */
export interface StepOutcome {
  next: { step: MeetingStep; delaySeconds: number } | null;
  usage: Usage;
  changed: string | null;
}

export const POLL_SECONDS = 20;
/** Three hours of polls: an engine that has not answered by then is not going to. */
export const MAX_POLLS = 540;
const MODEL_TIMEOUT_MS = 60_000;
const NONE: Usage = { tokensIn: 0, tokensOut: 0 };

/** A failure no retry can fix: the meeting is marked failed with it. */
export class MeetingStepFailed extends Error {}

export interface MeetingRun {
  env: Env;
  db: Db;
  config: Config;
  log: Logger;
}

export function meetingEngine(config: Config, env: Env) {
  const ai = (env as unknown as { AI?: EngineConfig["ai"] }).AI;
  if (config.TRANSCRIBE_PROVIDER === "workers-ai" && !ai) return null;
  return engineFor({
    provider: config.TRANSCRIBE_PROVIDER,
    url: config.TRANSCRIBE_URL,
    model: config.TRANSCRIBE_MODEL,
    apiKey: config.TRANSCRIBE_API_KEY,
    ai: (
      env as unknown as {
        AI?: { run: (m: string, i: Record<string, unknown>) => Promise<unknown> };
      }
    ).AI,
  });
}

function anthropicOf(config: Config) {
  if (!config.ANTHROPIC_API_KEY) return null;
  return new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    baseURL: config.ANTHROPIC_BASE_URL ?? null,
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: 0,
  });
}

const rawKey = (orgId: string, meetingId: string) => `meetings/${orgId}/${meetingId}/engine.json`;

const outcome = (next: StepOutcome["next"], changed: string | null, usage = NONE) =>
  ({ next, usage, changed }) satisfies StepOutcome;

/**
 * Runs one step. Each step reads the meeting fresh and does nothing when the meeting is already
 * past it, so a step delivered twice changes nothing. Throws `EngineError` (retryable or not) and
 * `MeetingStepFailed`; the queue retries the first kind and fails the meeting on the others.
 */
export async function runMeetingStep(run: MeetingRun, job: MeetingJob) {
  const pipeline = meetingsPipeline(run.db);
  const found = await pipeline.meeting(job.meetingId);
  if (!found || found.meeting.orgId !== job.orgId) return outcome(null, null);
  const step = stepFor(found);
  if (!step) return outcome(null, null);
  try {
    const engine = meetingEngine(run.config, run.env);
    if (!engine) throw new MeetingStepFailed("no transcription engine is configured");
    if (step === "transcribe") return await transcribe(run, engine, found);
    if (step === "poll") return await poll(run, engine, found);
    if (step === "name") return await name(run, found);
    return await write(run, found);
  } catch (error) {
    throw new StepError(
      error,
      found.meeting.status === "uploaded" ? ["uploaded", "transcribing"] : [found.meeting.status],
    );
  }
}

/** A step's failure, with the status the meeting was at when the step began. */
export class StepError extends Error {
  override readonly cause: unknown;
  readonly from: MeetingStatus[];
  constructor(cause: unknown, from: MeetingStatus[]) {
    super(cause instanceof Error ? cause.message : "the step failed");
    this.cause = cause;
    this.from = from;
  }
}

/**
 * The step the meeting's saved status calls for, whatever step the message named: a message
 * delivered late or twice, or one whose follow-up never reached the queue, carries on from where
 * the meeting is instead of stopping.
 */
export function stepFor(found: {
  meeting: { status: string };
  job: { providerJobId: string | null };
}) {
  const { status } = found.meeting;
  if (status === "uploaded") return "transcribe";
  if (status === "transcribing") return found.job.providerJobId ? "poll" : "transcribe";
  if (status === "naming") return "name";
  if (status === "writing") return "write";
  return null;
}

type Found = NonNullable<Awaited<ReturnType<ReturnType<typeof meetingsPipeline>["meeting"]>>>;

async function transcribe(run: MeetingRun, engine: Engine, found: Found) {
  const { meeting, job } = found;
  const pipeline = meetingsPipeline(run.db);
  if (meeting.status === "uploaded")
    await pipeline.advance(meeting.id, ["uploaded"], "transcribing");
  else if (meeting.status !== "transcribing") return outcome(null, null);
  if (job.providerJobId) return outcome({ step: "poll", delaySeconds: 0 }, "transcribing");
  if (!(await pipeline.claimSubmission(meeting.id))) {
    return outcome({ step: "transcribe", delaySeconds: POLL_SECONDS }, null);
  }
  try {
    return await submit(run, engine, found);
  } catch (error) {
    await pipeline.releaseSubmission(meeting.id);
    throw error;
  }
}

async function submit(run: MeetingRun, engine: Engine, found: Found) {
  const { meeting } = found;
  const pipeline = meetingsPipeline(run.db);
  if (!meeting.audioNodeId) throw new MeetingStepFailed("the recording is missing");
  const file = await storageWorkspaceFile(run.db, meeting.orgId, meeting.audioNodeId);
  const object = file ? await run.env.STORAGE_BUCKET.get(file.r2Key) : null;
  if (!file || !object) throw new MeetingStepFailed("the recording is missing");
  const names = [found.recorder?.name, ...found.attendees.map((a) => a.name)].filter(
    (n): n is string => !!n,
  );
  const submitted = await engine.submit(
    { body: object.body, size: object.size, contentType: file.mimeType ?? "audio/ogg" },
    {
      names,
      terms: meeting.title ? [meeting.title] : [],
      maxSpeakers: found.attendees.length + 1,
    },
  );
  if ("result" in submitted) return save(run, engine, found, submitted.result, null);
  if (!(await pipeline.setEngineJob(meeting.id, engine.provider, submitted.jobId))) {
    await forget(run, engine, submitted.jobId);
    return outcome({ step: "poll", delaySeconds: POLL_SECONDS }, null);
  }
  return outcome({ step: "poll", delaySeconds: POLL_SECONDS }, "transcribing");
}

async function poll(run: MeetingRun, engine: Engine, found: Found) {
  const { meeting, job } = found;
  if (meeting.status !== "transcribing") return outcome(null, null);
  if (!job.providerJobId) return outcome({ step: "transcribe", delaySeconds: 0 }, null);
  const polls = await meetingsPipeline(run.db).countPoll(meeting.id);
  if (polls > MAX_POLLS) throw new MeetingStepFailed("the transcription engine did not answer");
  const polled = await engine.poll(job.providerJobId);
  if (polled.state === "pending")
    return outcome({ step: "poll", delaySeconds: POLL_SECONDS }, null);
  if (polled.state === "error")
    throw new MeetingStepFailed(`transcription failed: ${polled.error}`);
  return save(run, engine, found, polled.result, job.providerJobId);
}

async function forget(run: MeetingRun, engine: Engine, jobId: string) {
  await engine
    .forget(jobId)
    .catch((error: unknown) => run.log.warn("meetings.forget_failed", { error }));
}

async function save(
  run: MeetingRun,
  engine: Engine,
  found: Found,
  result: unknown,
  jobId: string | null,
) {
  const { meeting, job } = found;
  await run.env.STORAGE_BUCKET.put(rawKey(meeting.orgId, meeting.id), JSON.stringify(result), {
    httpMetadata: { contentType: "application/json" },
  });
  const transcript = normalizeTranscript(engine.provider, result);
  const turns = restoreTimes(transcript.turns, job.cuts ?? []);
  const recorder = found.recorder ?? { address: "", name: null };
  const speakers = resolveSpeakers({
    turns,
    micSpans: job.micSpans,
    recorder,
    attendees: found.attendees,
    engineNames: transcript.engineNames,
  });
  const saved = await meetingsPipeline(run.db).saveTranscript(meeting.id, meeting.orgId, {
    language: transcript.language,
    durationMs: Math.max(transcript.durationMs, meeting.durationMs ?? 0),
    rawNodeId: null,
    turns,
    speakers,
  });
  if (saved === "gone") await deleteMeetingObjects(run.env, meeting.orgId, meeting.id);
  if (jobId && saved !== "moved_on") await forget(run, engine, jobId);
  return saved === "saved"
    ? outcome({ step: "name", delaySeconds: 0 }, "naming")
    : outcome(null, null);
}

const speakersOf = (found: Found) =>
  found.speakers.map(
    (s) =>
      ({
        label: s.label,
        name: s.name,
        address: s.address,
        source: s.source,
        confidence: s.confidence,
      }) satisfies ResolvedSpeaker,
  );

const turnsOf = (found: Found) =>
  found.segments.map((s) => ({
    speaker: s.speakerLabel,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text,
  }));

async function name(run: MeetingRun, found: Found) {
  const { meeting } = found;
  const pipeline = meetingsPipeline(run.db);
  if (meeting.status !== "naming") return outcome(null, null);
  const speakers = speakersOf(found);
  const client = anthropicOf(run.config);
  let usage = NONE;
  if (client && speakers.some((s) => !s.name)) {
    const result = await nameSpeakers(client, {
      turns: turnsOf(found),
      speakers,
      attendees: found.attendees,
    });
    usage = result.usage;
    await pipeline.nameSpeakers(meeting.id, result.named);
  }
  await pipeline.advance(meeting.id, ["naming"], "writing");
  return outcome({ step: "write", delaySeconds: 0 }, "writing", usage);
}

async function write(run: MeetingRun, found: Found) {
  const { meeting } = found;
  if (meeting.status !== "writing") return outcome(null, null);
  const client = anthropicOf(run.config);
  const pipeline = meetingsPipeline(run.db);
  const empty = {
    title: null,
    summary: "",
    highlights: [],
    topics: [],
    actions: [],
    model: "none",
    promptVersion: NOTES_PROMPT_VERSION,
  };
  if (!client || found.segments.length === 0) {
    const saved = await pipeline.saveNotes(meeting.id, meeting.orgId, empty);
    return outcome(null, saved ? "ready" : null);
  }
  const result = await writeNotes(client, {
    title: meeting.title,
    description: null,
    attendees: found.attendees,
    personNotes: null,
    turns: turnsOf(found),
    titles: speakerTitles(speakersOf(found)),
    durationMs: meeting.durationMs ?? 0,
    language: meeting.language,
  });
  if (!result.ok) throw new MeetingStepFailed(`the notes could not be written (${result.reason})`);
  const { notes } = result;
  await enqueueNotesDoc(run.env, meeting);
  const saved = await pipeline.saveNotes(meeting.id, meeting.orgId, {
    title: notes.title,
    summary: notes.summary,
    highlights: notes.highlights,
    topics: notes.topics,
    actions: notes.actions.map(({ kind, ...payload }) => ({ kind, payload })),
    model: AI_MODEL,
    promptVersion: NOTES_PROMPT_VERSION,
  });
  return outcome(null, saved ? "ready" : null, result.usage);
}

/** Whether a thrown error is worth a retry: transient engine and model failures are. */
export function retryable(thrown: unknown) {
  const error = thrown instanceof StepError ? thrown.cause : thrown;
  if (error instanceof MeetingStepFailed) return false;
  if (error instanceof EngineError) return error.retryable;
  return true;
}

/** Tells the members who can open the meeting that it changed. Never fails the job. */
export async function announceMeeting(
  run: MeetingRun,
  orgId: string,
  meetingId: string,
  status: string,
) {
  try {
    const memberIds = await meetingsPipeline(run.db).audience(meetingId);
    if (memberIds.length === 0) return;
    const stub = run.env.REALTIME.get(run.env.REALTIME.idFromName(orgId));
    await stub.broadcast(memberIds, { type: "meetings.changed", meetingId, status });
  } catch (error) {
    run.log.warn("meetings.announce_failed", { error });
  }
}

/**
 * Deletes everything the pipeline kept in R2 for a meeting, under `meetings/<org>/<meeting>/`:
 * the engine's raw answer and any audio the recorder sent. Safe to run twice.
 */
export async function deleteMeetingObjects(env: Env, orgId: string, meetingId: string) {
  const prefix = `meetings/${orgId}/${meetingId}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.STORAGE_BUCKET.list({ prefix, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length) await env.STORAGE_BUCKET.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
