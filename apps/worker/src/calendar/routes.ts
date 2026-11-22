import {
  calendarAnswerBodySchema,
  calendarCreateEventBodySchema,
  calendarEventsQuerySchema,
  calendarInvitesQuerySchema,
  calendarPrefsBodySchema,
  calendarUpdateEventBodySchema,
  type CalendarEventResponse,
  type CalendarEventsResponse,
  type CalendarInvitesResponse,
  type CalendarListResponse,
} from "@omni/contracts";
import { replyHeadersOf } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { pingMailService } from "../mail-service.ts";
import { zValidator } from "../validator.ts";
import { bookingLinks } from "./booking.ts";
import { announceCalendars, memberCalendar, refused, wireEvent } from "./http.ts";
import { tasks } from "./tasks.ts";

const date = (value: string) => new Date(value);
const dates = <T extends { start?: string; end?: string }>(body: T) => ({
  ...body,
  ...(body.start ? { start: date(body.start) } : {}),
  ...(body.end ? { end: date(body.end) } : {}),
});

async function afterWrite(c: Context<AppEnv>, eventId: string) {
  c.executionCtx.waitUntil(pingMailService(c.var));
  const found = await memberCalendar(c).event(eventId);
  if (found.status !== "ok") return found;
  c.executionCtx.waitUntil(
    announceCalendars(c.env, c.var.db, c.var.log, [
      { calendarId: found.event.calendarId, mailboxId: found.event.mailboxId },
    ]),
  );
  return found;
}

export const calendar = new Hono<AppEnv>()
  .route("/", tasks)
  .route("/", bookingLinks)
  .get("/calendars", async (c) => {
    const calendars = await memberCalendar(c).calendars();
    return c.json({
      calendars: calendars.map(({ orgId: _org, ...calendar }) => calendar),
    } satisfies CalendarListResponse);
  })

  .patch("/calendars/:id", zValidator("json", calendarPrefsBodySchema), async (c) => {
    const set = await memberCalendar(c).setPrefs(c.req.param("id"), c.req.valid("json"));
    if (set.status !== "ok") return refused(c, set);
    return c.body(null, 204);
  })

  .get("/events", zValidator("query", calendarEventsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const found = await memberCalendar(c).events({
      from: date(query.from),
      to: date(query.to),
      ...(query.calendar?.length ? { calendarIds: query.calendar } : {}),
    });
    if (found.status !== "ok") return refused(c, found);
    return c.json({ events: found.events.map(wireEvent) } satisfies CalendarEventsResponse);
  })

  .get("/events/:id", async (c) => {
    const found = await memberCalendar(c).event(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    const { event } = found;
    const headers = event.messageId
      ? await replyHeadersOf(c.var.db, { mailboxId: event.mailboxId, messageId: event.messageId })
      : null;
    return c.json({
      event: wireEvent(event),
      threadId: headers?.threadId ?? null,
    } satisfies CalendarEventResponse);
  })

  .post("/events", zValidator("json", calendarCreateEventBodySchema), async (c) => {
    const body = c.req.valid("json");
    const made = await memberCalendar(c).createEvent(
      { ...dates(body), start: date(body.start), end: date(body.end) },
      c.var.requestId,
    );
    if (made.status !== "ok") return refused(c, made);
    const found = await afterWrite(c, made.eventId);
    if (found.status !== "ok") return refused(c, found);
    return c.json(
      { event: wireEvent(found.event), threadId: null } satisfies CalendarEventResponse,
      201,
    );
  })

  .patch("/events/:id", zValidator("json", calendarUpdateEventBodySchema), async (c) => {
    const changed = await memberCalendar(c).updateEvent(
      c.req.param("id"),
      dates(c.req.valid("json")),
      c.var.requestId,
    );
    if (changed.status !== "ok") return refused(c, changed);
    const found = await afterWrite(c, changed.eventId);
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      event: wireEvent(found.event),
      threadId: null,
    } satisfies CalendarEventResponse);
  })

  .delete("/events/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await memberCalendar(c).deleteEvent(id, c.var.requestId);
    if (deleted.status !== "ok") return refused(c, deleted);
    await afterWrite(c, id);
    return c.body(null, 204);
  })

  .post("/events/:id/answer", zValidator("json", calendarAnswerBodySchema), async (c) => {
    const id = c.req.param("id");
    const answered = await memberCalendar(c).answer(
      id,
      c.req.valid("json").response,
      c.var.requestId,
    );
    if (answered.status !== "ok") return refused(c, answered);
    const found = answered.changed ? await afterWrite(c, id) : await memberCalendar(c).event(id);
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      event: wireEvent(found.event),
      threadId: null,
    } satisfies CalendarEventResponse);
  })

  .get("/invites", zValidator("query", calendarInvitesQuerySchema), async (c) => {
    const found = await memberCalendar(c).invites(c.req.valid("query").thread);
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      invites: found.invites.map((invite) => ({ ...invite, event: wireEvent(invite.event) })),
    } satisfies CalendarInvitesResponse);
  });
