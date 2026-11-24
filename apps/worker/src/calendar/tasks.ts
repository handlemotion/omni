import {
  calendarCreateTaskBodySchema,
  calendarTaskCommentBodySchema,
  calendarTasksQuerySchema,
  calendarUpdateTaskBodySchema,
  type CalendarTaskActivityItem,
  type CalendarTaskActivityResponse,
  type CalendarTaskCommentResponse,
  type CalendarTask as WireTask,
  type CalendarTaskListResponse,
  type CalendarTaskResponse,
} from "@omni/contracts";
import type { CalendarTask, TaskActivityItem } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { errorBody } from "../errors.ts";
import { zValidator } from "../validator.ts";
import { memberCalendar } from "./http.ts";
import { decodeCursor, encodeCursor } from "../cursor.ts";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? iso(date) : null);

export const wireTask = (task: CalendarTask) =>
  ({
    id: task.id,
    title: task.title,
    body: task.body,
    subtasks: task.subtasks,
    ownerMemberId: task.ownerMemberId,
    assigneeMemberId: task.assigneeMemberId,
    record: task.record,
    status: task.status,
    priority: task.priority,
    dueAt: isoOrNull(task.dueAt),
    completedAt: isoOrNull(task.completedAt),
    completedByMemberId: task.completedByMemberId,
    createdByMemberId: task.createdByMemberId,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  }) satisfies WireTask;

/** An activity item as the API sends it: its times as ISO strings. */
export function wireTaskActivity(item: TaskActivityItem) {
  const base = { id: item.id, actorMemberId: item.actorMemberId, at: iso(item.at) };
  const wire: CalendarTaskActivityItem =
    item.kind === "due"
      ? { ...base, kind: "due", from: isoOrNull(item.from), to: isoOrNull(item.to) }
      : { ...base, ...item, at: base.at };
  return wire;
}

/** A comment with no text. */
export const emptyComment = (c: Context<AppEnv>) =>
  c.json(errorBody(c, "bad_request", "a comment needs text", { param: "body" }), 400);

const taskCursor = z.object({ at: z.iso.datetime().nullable(), id: z.string().min(1) });

function decodeTaskCursor(value: string | undefined) {
  const cursor = decodeCursor(value, taskCursor);
  return cursor && { at: cursor.at ? new Date(cursor.at) : null, id: cursor.id };
}

function refusedTask(c: Context<AppEnv>, refusal: { status: "not_found" | "invalid_title" }) {
  if (refusal.status === "invalid_title") {
    return c.json(errorBody(c, "bad_request", "a task needs a title", { param: "title" }), 400);
  }
  return c.json(errorBody(c, "not_found", "no such task, or it is not yours"), 404);
}

const dateOrNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

/**
 * The member's tasks (`docs/spec/calendar.md`, "Tasks"): the ones they own and the ones assigned
 * to them, in every workspace, a Personal space included. A linked task's record and assignee
 * change through the CRM's routes.
 */
export const tasks = new Hono<AppEnv>()
  .get("/tasks", zValidator("query", calendarTasksQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const listed = await memberCalendar(c).tasks({
      status: query.status,
      due: query.due,
      cursor: decodeTaskCursor(query.cursor),
      limit: query.limit,
    });
    if (listed.status !== "ok") return refusedTask(c, listed);
    const next = listed.nextCursor
      ? { at: isoOrNull(listed.nextCursor.at), id: listed.nextCursor.id }
      : null;
    return c.json({
      tasks: listed.tasks.map(wireTask),
      nextCursor: encodeCursor(next),
    } satisfies CalendarTaskListResponse);
  })

  .post("/tasks", zValidator("json", calendarCreateTaskBodySchema), async (c) => {
    const body = c.req.valid("json");
    const made = await memberCalendar(c).createTask({
      title: body.title,
      body: body.body,
      subtasks: body.subtasks,
      dueAt: dateOrNull(body.dueAt),
    });
    if (made.status !== "ok") return refusedTask(c, made);
    return c.json({ task: wireTask(made.task) } satisfies CalendarTaskResponse, 201);
  })

  .get("/tasks/:id", async (c) => {
    const found = await memberCalendar(c).task(c.req.param("id"));
    if (found.status !== "ok") return refusedTask(c, found);
    return c.json({ task: wireTask(found.task) } satisfies CalendarTaskResponse);
  })

  .patch("/tasks/:id", zValidator("json", calendarUpdateTaskBodySchema), async (c) => {
    const body = c.req.valid("json");
    const changed = await memberCalendar(c).updateTask(c.req.param("id"), {
      title: body.title,
      body: body.body,
      subtasks: body.subtasks,
      dueAt: dateOrNull(body.dueAt),
      done: body.done,
      status: body.status,
      priority: body.priority,
    });
    if (changed.status !== "ok") return refusedTask(c, changed);
    return c.json({ task: wireTask(changed.task) } satisfies CalendarTaskResponse);
  })

  .delete("/tasks/:id", async (c) => {
    const deleted = await memberCalendar(c).deleteTask(c.req.param("id"));
    if (deleted.status !== "ok") return refusedTask(c, deleted);
    return c.body(null, 204);
  })

  .get("/tasks/:id/activity", async (c) => {
    const found = await memberCalendar(c).taskActivity(c.req.param("id"));
    if (found.status !== "ok") return refusedTask(c, found);
    return c.json({
      items: found.items.map(wireTaskActivity),
    } satisfies CalendarTaskActivityResponse);
  })

  .post("/tasks/:id/comments", zValidator("json", calendarTaskCommentBodySchema), async (c) => {
    const made = await memberCalendar(c).commentOnTask(c.req.param("id"), c.req.valid("json").body);
    if (made.status === "empty_comment") return emptyComment(c);
    if (made.status !== "ok") return refusedTask(c, made);
    return c.json({ item: wireTaskActivity(made.item) } satisfies CalendarTaskCommentResponse, 201);
  });
