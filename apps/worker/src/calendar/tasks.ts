import {
  calendarCreateTaskBodySchema,
  calendarTasksQuerySchema,
  calendarUpdateTaskBodySchema,
  type CalendarTask as WireTask,
  type CalendarTaskListResponse,
  type CalendarTaskResponse,
} from "@omni/contracts";
import type { CalendarTask } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { ApiFailure, errorBody } from "../errors.ts";
import { zValidator } from "../validator.ts";
import { memberCalendar } from "./http.ts";

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
    dueAt: isoOrNull(task.dueAt),
    completedAt: isoOrNull(task.completedAt),
    completedByMemberId: task.completedByMemberId,
    createdByMemberId: task.createdByMemberId,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  }) satisfies WireTask;

const taskCursor = z.object({ at: z.iso.datetime().nullable(), id: z.string().min(1) });

function encodeCursor(cursor: z.infer<typeof taskCursor> | null) {
  if (!cursor) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string | undefined) {
  if (value === undefined) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const cursor = taskCursor.parse(JSON.parse(json));
    return { at: cursor.at ? new Date(cursor.at) : null, id: cursor.id };
  } catch {
    throw new ApiFailure("bad_request", "invalid cursor", { param: "cursor" });
  }
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
      cursor: decodeCursor(query.cursor),
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
    });
    if (changed.status !== "ok") return refusedTask(c, changed);
    return c.json({ task: wireTask(changed.task) } satisfies CalendarTaskResponse);
  })

  .delete("/tasks/:id", async (c) => {
    const deleted = await memberCalendar(c).deleteTask(c.req.param("id"));
    if (deleted.status !== "ok") return refusedTask(c, deleted);
    return c.body(null, 204);
  });
