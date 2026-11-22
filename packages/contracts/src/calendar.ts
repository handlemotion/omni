import { z } from "zod";

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime({ offset: true });
const day = z.iso.date();

/** The longest window one events read covers. */
export const CALENDAR_WINDOW_MAX_DAYS = 62;
export const CALENDAR_GUESTS_MAX = 100;
export const CALENDAR_TITLE_MAX = 500;
export const CALENDAR_TEXT_MAX = 20_000;

export const calendarResponseSchema = z.enum([
  "needs_action",
  "accepted",
  "declined",
  "tentative",
  "delegated",
]);

export const calendarAttendeeSchema = z.object({
  address: z.string(),
  name: z.string().nullable(),
  role: z.enum(["chair", "required", "optional", "none"]),
  response: calendarResponseSchema,
});

/** A calendar: one per inbox the member can open, with their own color and toggle. */
export const calendarSchema = z.object({
  id,
  mailboxId: id,
  /** The inbox's address: the calendar's name, and who sends its invitations. */
  address: z.string(),
  kind: z.string(),
  /** The member's own color, `#rrggbb`; null for the app's default. */
  color: z.string().nullable(),
  hidden: z.boolean(),
});

/** One event, or one instance of a series. */
export const calendarEventSchema = z.object({
  /** The event's row. Instances of a series share it; `recurrenceId` tells them apart. */
  id,
  calendarId: id,
  mailboxId: id,
  uid: z.string(),
  /** The instance's original start, for an instance of a series. */
  recurrenceId: isoDate.nullable(),
  recurring: z.boolean(),
  /** `invite` came by mail; `omni` was made in Omni and may be changed by its organizer. */
  source: z.enum(["invite", "omni", "google"]),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  busy: z.boolean(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  /** An `https:` link to join the call. */
  conferenceUrl: z.string().nullable(),
  start: isoDate,
  end: isoDate,
  allDay: z.boolean(),
  /** `YYYY-MM-DD` for an all-day event; `endDay` is exclusive. */
  startDay: day.nullable(),
  endDay: day.nullable(),
  timeZone: z.string().nullable(),
  organizer: z.object({ address: z.string(), name: z.string().nullable() }).nullable(),
  /** The inbox organizes it. */
  organizing: z.boolean(),
  attendees: z.array(calendarAttendeeSchema),
  /** The inbox's own answer; null when it is not invited. */
  myResponse: calendarResponseSchema.nullable(),
});

export const calendarEventsQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    /** One or several calendar ids, comma separated; default every calendar the member shows. */
    calendar: z
      .string()
      .transform((value) => value.split(",").filter(Boolean))
      .optional(),
  })
  .refine((q) => Date.parse(q.to) > Date.parse(q.from), {
    message: "to must be after from",
    path: ["to"],
  });

export const calendarInvitesQuerySchema = z.object({ thread: id });

export const calendarPrefsBodySchema = z
  .object({
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .nullable()
      .optional(),
    hidden: z.boolean().optional(),
  })
  .refine((body) => body.color !== undefined || body.hidden !== undefined, {
    message: "give color or hidden",
  });

export const calendarAnswerBodySchema = z.object({
  response: z.enum(["accepted", "declined", "tentative"]),
});

const guestSchema = z.object({
  address: z.email().max(320),
  name: z.string().max(CALENDAR_TITLE_MAX).nullable().optional(),
});

const eventFields = {
  title: z.string().trim().min(1).max(CALENDAR_TITLE_MAX),
  start: isoDate,
  end: isoDate,
  allDay: z.boolean().optional(),
  timeZone: z.string().max(64).nullable().optional(),
  location: z.string().max(CALENDAR_TITLE_MAX).nullable().optional(),
  description: z.string().max(CALENDAR_TEXT_MAX).nullable().optional(),
  conferenceUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable()
    .optional(),
  busy: z.boolean().optional(),
  guests: z.array(guestSchema).max(CALENDAR_GUESTS_MAX).optional(),
};

export const calendarCreateEventBodySchema = z.object({ calendarId: id, ...eventFields });
export const calendarUpdateEventBodySchema = z
  .object(eventFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "change at least one field" });

export const calendarListResponseSchema = z.object({ calendars: z.array(calendarSchema) });
export const calendarEventsResponseSchema = z.object({ events: z.array(calendarEventSchema) });
export const calendarEventResponseSchema = z.object({
  event: calendarEventSchema,
  /** The thread it came in, when the member can open it. */
  threadId: id.nullable(),
});
export const calendarInvitesResponseSchema = z.object({
  invites: z.array(
    z.object({
      /** The message that carried it. */
      messageId: id.nullable(),
      method: z.string().nullable(),
      event: calendarEventSchema,
    }),
  ),
});

/** A calendar's events changed: refetch the windows that show them. */
export const calendarChangedEventSchema = z.object({
  type: z.literal("calendar.changed"),
  calendarIds: z.array(id).min(1),
});

export type Calendar = z.infer<typeof calendarSchema>;
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarAttendee = z.infer<typeof calendarAttendeeSchema>;
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;
export type CalendarListResponse = z.infer<typeof calendarListResponseSchema>;
export type CalendarEventsResponse = z.infer<typeof calendarEventsResponseSchema>;
export type CalendarEventResponse = z.infer<typeof calendarEventResponseSchema>;
export type CalendarInvitesResponse = z.infer<typeof calendarInvitesResponseSchema>;
export type CalendarChangedEvent = z.infer<typeof calendarChangedEventSchema>;

export const CALENDAR_TASK_TITLE_MAX = 500;
export const CALENDAR_TASK_BODY_MAX = 20_000;
export const CALENDAR_TASK_STEPS_MAX = 100;

/** A step of a task's checklist, with an id the client makes. */
export const calendarTaskStepSchema = z.object({
  id,
  title: z.string().max(CALENDAR_TASK_TITLE_MAX),
  done: z.boolean(),
});

/**
 * A task (`docs/spec/calendar.md`, "Tasks"): private to its owner while `record` is null; on a
 * CRM company, person or deal it is the workspace's. The record's name is the CRM's to give.
 */
export const calendarTaskSchema = z.object({
  id,
  title: z.string(),
  body: z.string().nullable(),
  subtasks: z.array(calendarTaskStepSchema),
  ownerMemberId: id.nullable(),
  assigneeMemberId: id.nullable(),
  record: z.object({ kind: z.enum(["company", "person", "deal"]), id }).nullable(),
  /** A moment: a client picking a day sends the end of that day in its time zone. */
  dueAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
  completedByMemberId: id.nullable(),
  createdByMemberId: id.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

/** `GET /tasks`: the member's own and assigned tasks, open soonest due first or `done` latest first. */
export const calendarTasksQuerySchema = z.object({
  status: z.enum(["open", "done"]).optional(),
  due: z.enum(["overdue", "upcoming", "none"]).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** `POST /tasks`: a private task, the caller's. */
export const calendarCreateTaskBodySchema = z.object({
  title: z.string().max(CALENDAR_TASK_TITLE_MAX),
  body: z.string().max(CALENDAR_TASK_BODY_MAX).nullable().optional(),
  subtasks: z.array(calendarTaskStepSchema).max(CALENDAR_TASK_STEPS_MAX).optional(),
  dueAt: isoDate.nullable().optional(),
});

/**
 * `PATCH /tasks/:id`: only the fields it names; `done` completes or reopens it. A task's record
 * and assignee change through the CRM's task routes.
 */
export const calendarUpdateTaskBodySchema = z.object({
  title: z.string().max(CALENDAR_TASK_TITLE_MAX).optional(),
  body: z.string().max(CALENDAR_TASK_BODY_MAX).nullable().optional(),
  subtasks: z.array(calendarTaskStepSchema).max(CALENDAR_TASK_STEPS_MAX).optional(),
  dueAt: isoDate.nullable().optional(),
  done: z.boolean().optional(),
});

export const calendarTaskResponseSchema = z.object({ task: calendarTaskSchema });
export const calendarTaskListResponseSchema = z.object({
  tasks: z.array(calendarTaskSchema),
  nextCursor: z.string().nullable(),
});

export type CalendarTask = z.infer<typeof calendarTaskSchema>;
export type CalendarTaskStep = z.infer<typeof calendarTaskStepSchema>;
export type CalendarTasksQuery = z.infer<typeof calendarTasksQuerySchema>;
export type CalendarCreateTaskBody = z.infer<typeof calendarCreateTaskBodySchema>;
export type CalendarUpdateTaskBody = z.infer<typeof calendarUpdateTaskBodySchema>;
export type CalendarTaskResponse = z.infer<typeof calendarTaskResponseSchema>;
export type CalendarTaskListResponse = z.infer<typeof calendarTaskListResponseSchema>;
