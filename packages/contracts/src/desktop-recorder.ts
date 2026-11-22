import { z } from "zod";

const ms = z.number().int().min(0);
const span = z.object({ startMs: ms, endMs: ms });

/** `recording` and `paused` while capturing; `stopped` once the file is whole and stays as is. */
export const desktopRecordingStateSchema = z.enum(["recording", "paused", "stopped"]);

/**
 * One recording in the desktop recorder's spool (docs/spec/meetings.md, "The desktop recorder"):
 * the one capturing, or one left to upload. The shell captures, encodes and keeps the spool; the
 * page, which holds the session, starts the meeting, uploads the spool through Drive's resumable
 * upload and stops it (`finishRecording` in `@omni/client`). The shell leaves out a field that
 * has no value rather than sending `null`.
 */
export const desktopRecordingSchema = z.object({
  /** The spool's own id, made on this computer. */
  id: z.string(),
  meetingId: z.string(),
  /** The member who started it: only their session finishes it. */
  memberId: z.string(),
  /** The recorder's `Recordings` folder, from `POST /api/meetings`. */
  folderId: z.string(),
  title: z.string().nullish(),
  state: desktopRecordingStateSchema,
  /** When capture began, in milliseconds since the epoch. */
  startedAtMs: ms,
  /** Audio in the file so far; paused time is not in it (see `cuts`). */
  durationMs: ms,
  /** Bytes in the spool's file. */
  size: ms,
  /** When the person at this computer spoke, in the audio's time. */
  micSpans: z.array(span),
  /** Where paused time was left out: `atMs` in the audio, `droppedMs` of meeting time. */
  cuts: z.array(z.object({ atMs: ms, droppedMs: z.number().int().min(1) })),
  /** The Drive upload the spool is going up as, once opened. */
  uploadId: z.string().nullish(),
  /** The Drive file it became, once completed. */
  nodeId: z.string().nullish(),
  /** The microphone's level just now, in dBFS (-120 is silence); for the pill. */
  micDb: z.number(),
});

/** Why the shell could not start capturing. */
export const desktopRecorderErrorSchema = z.object({
  code: z.enum([
    "unavailable",
    "permission_denied",
    "already_recording",
    "already_spooled",
    "failed",
  ]),
  message: z.string(),
});

const calendarMeetingByEventId = {
  id: z.string(),
  recurrenceId: z.string().nullish(),
  title: z.string().nullish(),
};

/**
 * Shell → page events. `recording-changed` carries a `DesktopRecording` (about four times a
 * second while capturing, for the pill's clock and level, and once when it stops: the page then
 * finishes it). `recording-requested` (tray "Record now") asks the page to start one, and
 * `recording-offered` says a calendar meeting with a video link just began, for `event`; the
 * notification says "Record <title>?". Either way the page asks for consent, calls
 * `POST /api/meetings`, then `recording_start`: the shell never starts one alone.
 */
export const desktopRecordingRequestSchema = z.object({
  event: z.object(calendarMeetingByEventId).nullish(),
});

/** `recording_schedule`: the page's upcoming meetings, so the shell can offer to record each. */
export const desktopRecordingScheduleSchema = z.object({
  events: z
    .array(
      z.object({
        ...calendarMeetingByEventId,
        startsAtMs: ms,
        endsAtMs: ms,
        /** Only a meeting with a video link is offered: a call to record. */
        hasVideoLink: z.boolean(),
      }),
    )
    .max(200),
});

/** The schemas the desktop recorder is generated from, by the name its type takes. */
export const DESKTOP_RECORDER_NATIVE_TYPES = {
  DesktopRecordingState: desktopRecordingStateSchema,
  DesktopRecording: desktopRecordingSchema,
  DesktopRecorderError: desktopRecorderErrorSchema,
  DesktopRecordingRequest: desktopRecordingRequestSchema,
  DesktopRecordingSchedule: desktopRecordingScheduleSchema,
} as const;

export type DesktopRecording = z.infer<typeof desktopRecordingSchema>;
export type DesktopRecorderError = z.infer<typeof desktopRecorderErrorSchema>;
export type DesktopRecordingRequest = z.infer<typeof desktopRecordingRequestSchema>;
export type DesktopRecordingSchedule = z.infer<typeof desktopRecordingScheduleSchema>;
