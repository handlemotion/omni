import { z } from "zod";

const address = z.email().max(320);
const span = z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0) });

const recurrenceId = z.iso.datetime({ offset: true }).nullish();

/**
 * `POST /api/meetings`: start a recording. `event` is the calendar meeting it is of: its row and
 * instance as the calendar shows them (`{ id, recurrenceId }`), its `UID` (`{ uid, recurrenceId }`,
 * the first shape; `recurring` is ignored, the calendar knows), `"now"` (the default) for the
 * meeting the recorder is in, or `null` for none. The server reads the event and its attendees
 * from the recorder's calendars.
 */
export const startMeetingBodySchema = z.object({
  title: z.string().max(300).nullish(),
  event: z
    .union([
      z.object({ id: z.string().min(1).max(64), recurrenceId }),
      z.object({
        uid: z.string().min(1).max(1000),
        recurrenceId,
        recurring: z.boolean().optional(),
      }),
      z.literal("now"),
    ])
    .nullable()
    .default("now"),
  attendees: z
    .array(z.object({ address, name: z.string().max(200).nullish() }))
    .max(200)
    .default([]),
  consent: z.literal(true),
});

/** The most chunks one recording may have: a day of audio in 5-second chunks. */
export const MEETINGS_MAX_CHUNKS = 20_000;
/** The largest one chunk may be. */
export const MEETINGS_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * `PUT /api/meetings/:id/chunks/:seq?endMs=`: one piece of a recording, its bytes as the body
 * and their SHA-256 (hex) in `x-content-sha256`. Answered with the chunk it acknowledged.
 */
export const meetingChunkQuerySchema = z.object({
  endMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(48 * 3_600_000),
});

export const meetingChunkSchema = z.object({
  seq: z.number().int(),
  size: z.number().int(),
  sha256: z.string(),
  endMs: z.number().int(),
});

/** `GET /api/meetings/:id/chunks`: what the server holds, so a recorder knows what to send again. */
export const meetingChunksResponseSchema = z.object({
  status: z.string(),
  chunks: z.array(meetingChunkSchema),
});

/**
 * `POST /api/meetings/:id/stop`: the recording and what the recorder knows about it. The
 * recording is either one Drive file (`audioNodeId`) or the chunks `0..chunks-1` already sent.
 */
export const stopMeetingBodySchema = z
  .object({
    audioNodeId: z.string().min(1).max(64).optional(),
    chunks: z.number().int().min(1).max(MEETINGS_MAX_CHUNKS).optional(),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3_600_000),
    micSpans: z.array(span).max(20_000).nullable(),
    cuts: z
      .array(z.object({ atMs: z.number().int().min(0), droppedMs: z.number().int().min(1) }))
      .max(5_000)
      .default([]),
  })
  .refine((body) => (body.audioNodeId === undefined) !== (body.chunks === undefined), {
    message: "send either audioNodeId or chunks",
  });

export const changeMeetingBodySchema = z.object({
  title: z.string().max(300).nullable().optional(),
  access: z.enum(["restricted", "workspace"]).optional(),
  linkAccess: z.enum(["off", "signed_in", "anyone"]).optional(),
  /** `null` takes it off every record; it is put on one through the CRM's routes. */
  record: z.null().optional(),
});

export const grantMeetingBodySchema = z.object({ role: z.enum(["viewer", "editor"]) });

export const renameSpeakerBodySchema = z.object({
  name: z.string().min(1).max(200),
  address: address.nullish(),
});

export const meetingsListQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  group: z.string().max(400).optional(),
  /** One calendar meeting's recordings: its `UID`, and in a series the instance's original start. */
  event: z.string().min(1).max(1000).optional(),
  recurrence: z.iso.datetime({ offset: true }).optional(),
});

export const meetingsSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** `POST /api/meetings/ask`: one question about one meeting or one group. */
export const askMeetingsBodySchema = z
  .object({
    meetingId: z.string().min(1).max(64).optional(),
    groupKey: z.string().min(1).max(400).optional(),
    question: z.string().trim().min(1).max(1_000),
  })
  .refine((b) => (b.meetingId === undefined) !== (b.groupKey === undefined), {
    message: "ask about one meeting or one group",
  });

/** A moment the answer cites: `n` is its `[n]` marker in the answer. */
export interface MeetingsAskCitation {
  n: number;
  meetingId: string;
  atMs: number;
}

export interface MeetingsAskResponse {
  answer: string;
  citations: MeetingsAskCitation[];
}

/** A meeting's status or content changed: its page refetches. */
export const meetingsChangedEventSchema = z.object({
  type: z.literal("meetings.changed"),
  meetingId: z.string(),
  status: z.string(),
});

export type StartMeetingBody = z.infer<typeof startMeetingBodySchema>;
export type StopMeetingBody = z.infer<typeof stopMeetingBodySchema>;
export type MeetingChunk = z.infer<typeof meetingChunkSchema>;
export type MeetingChunksResponse = z.infer<typeof meetingChunksResponseSchema>;
export type ChangeMeetingBody = z.infer<typeof changeMeetingBodySchema>;
export type AskMeetingsBody = z.infer<typeof askMeetingsBodySchema>;
export type MeetingsChangedEvent = z.infer<typeof meetingsChangedEventSchema>;
