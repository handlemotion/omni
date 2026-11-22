import { z } from "zod";

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime();

/**
 * A recorded meeting on the record (`docs/spec/meetings.md`, "On a project"): put on it, or with
 * its people. `placed` when someone put it on this record. Only meetings the reader can open.
 */
export const crmMeetingSchema = z.object({
  id,
  title: z.string().nullable(),
  startedAt: isoDate,
  durationMs: z.number().int().nullable(),
  status: z.string(),
  summary: z.string().nullable(),
  openActions: z.number().int(),
  placed: z.boolean(),
});
/** A meeting in a record's timeline, at the time it started. */
export const crmTimelineMeetingItemSchema = z.object({
  kind: z.literal("meeting"),
  id,
  at: isoDate,
  meeting: crmMeetingSchema,
});
/** `GET /deals/:id/meetings`: the deal's Meetings tab, newest first. */
export const crmMeetingsQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export const crmMeetingsResponseSchema = z.object({
  meetings: z.array(crmMeetingSchema),
  nextCursor: z.string().nullable(),
});
export type CrmMeeting = z.infer<typeof crmMeetingSchema>;
export type CrmMeetingsResponse = z.infer<typeof crmMeetingsResponseSchema>;
