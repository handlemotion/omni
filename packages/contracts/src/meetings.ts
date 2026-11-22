import { z } from "zod";

const address = z.email().max(320);
const span = z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0) });

/** `POST /api/meetings`: start a recording, of a calendar event or of nothing. */
export const startMeetingBodySchema = z.object({
  title: z.string().max(300).nullish(),
  event: z
    .object({
      uid: z.string().min(1).max(1000),
      recurrenceId: z.string().max(100).nullish(),
      recurring: z.boolean().default(false),
    })
    .nullish(),
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
  record: z
    .object({ kind: z.string().min(1).max(40), id: z.string().min(1).max(64) })
    .nullable()
    .optional(),
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
