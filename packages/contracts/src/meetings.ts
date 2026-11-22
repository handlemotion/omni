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

/** `POST /api/meetings/:id/stop`: the uploaded recording and what the recorder knows about it. */
export const stopMeetingBodySchema = z.object({
  audioNodeId: z.string().min(1).max(64),
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

/** A meeting's status or content changed: its page refetches. */
export const meetingsChangedEventSchema = z.object({
  type: z.literal("meetings.changed"),
  meetingId: z.string(),
  status: z.string(),
});

export type StartMeetingBody = z.infer<typeof startMeetingBodySchema>;
export type StopMeetingBody = z.infer<typeof stopMeetingBodySchema>;
export type ChangeMeetingBody = z.infer<typeof changeMeetingBodySchema>;
export type MeetingsChangedEvent = z.infer<typeof meetingsChangedEventSchema>;
