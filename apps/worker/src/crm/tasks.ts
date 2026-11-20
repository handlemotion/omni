import {
  crmCreateTaskBodySchema,
  crmTasksQuerySchema,
  crmUpdateTaskBodySchema,
  type CrmTaskCountsResponse,
  type CrmTaskListResponse,
  type CrmTaskResponse,
} from "@omni/contracts";
import type { CrmRecordRef, CrmTask, TaskPatch } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announce, decodeCursor, encodeCursor, memberCrm, refused, wireTask } from "./http.ts";

const taskCursor = z.object({ at: z.iso.datetime().nullable(), id: z.string().min(1) });

type Linked = { companyId?: string | null; personId?: string | null; dealId?: string | null };

function recordOf(body: Linked) {
  let record: CrmRecordRef | null | undefined;
  if (body.companyId) record = { companyId: body.companyId };
  else if (body.personId) record = { personId: body.personId };
  else if (body.dealId) record = { dealId: body.dealId };
  else if ([body.companyId, body.personId, body.dealId].some((v) => v !== undefined)) record = null;
  return record;
}

const dateOrNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

async function announceTask(c: Context<AppEnv>, ...tasks: CrmTask[]) {
  await announce(
    c,
    "task",
    tasks.map((task) => task.id),
  );
  for (const [kind, key] of [
    ["company", "companyId"],
    ["person", "personId"],
    ["deal", "dealId"],
  ] as const) {
    await announce(
      c,
      kind,
      tasks.map((task) => task[key]),
    );
  }
}

export const tasks = new Hono<AppEnv>()
  .get("/tasks", zValidator("query", crmTasksQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const assigneeMemberId =
      query.assignee === "me" ? c.var.member.id : query.assignee === "none" ? null : query.assignee;
    const cursor = decodeCursor(query.cursor, taskCursor);
    const record = recordOf({
      companyId: query.company,
      personId: query.person,
      dealId: query.deal,
    });
    const listed = await memberCrm(c).listTasks({
      status: query.status,
      assigneeMemberId,
      due: query.due,
      record: record ?? undefined,
      q: query.q,
      cursor: cursor ? { at: cursor.at ? new Date(cursor.at) : null, id: cursor.id } : null,
      limit: query.limit,
    });
    if (listed.status !== "ok") return refused(c, listed);
    const next = listed.nextCursor
      ? { at: listed.nextCursor.at?.toISOString() ?? null, id: listed.nextCursor.id }
      : null;
    return c.json({
      tasks: listed.tasks.map(wireTask),
      nextCursor: encodeCursor(next),
    } satisfies CrmTaskListResponse);
  })

  .get("/tasks/counts", async (c) => {
    const counted = await memberCrm(c).taskCounts();
    if (counted.status !== "ok") return refused(c, counted);
    return c.json({ counts: counted.counts } satisfies CrmTaskCountsResponse);
  })

  .post("/tasks", zValidator("json", crmCreateTaskBodySchema), async (c) => {
    const body = c.req.valid("json");
    const made = await memberCrm(c).createTask({
      title: body.title,
      body: body.body,
      assigneeMemberId: body.assigneeMemberId,
      dueAt: dateOrNull(body.dueAt),
      record: recordOf(body),
    });
    if (made.status !== "ok") return refused(c, made);
    await announceTask(c, made.task);
    return c.json({ task: wireTask(made.task) } satisfies CrmTaskResponse, 201);
  })

  .get("/tasks/:id", async (c) => {
    const found = await memberCrm(c).task(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json({ task: wireTask(found.task) } satisfies CrmTaskResponse);
  })

  .patch("/tasks/:id", zValidator("json", crmUpdateTaskBodySchema), async (c) => {
    const body = c.req.valid("json");
    const crm = memberCrm(c);
    const before = await crm.task(c.req.param("id"));
    const patch: TaskPatch = {
      title: body.title,
      body: body.body,
      assigneeMemberId: body.assigneeMemberId,
      dueAt: dateOrNull(body.dueAt),
      done: body.done,
      record: recordOf(body),
    };
    const changed = await crm.updateTask(c.req.param("id"), patch);
    if (changed.status !== "ok") return refused(c, changed);
    await announceTask(c, changed.task, ...(before.status === "ok" ? [before.task] : []));
    return c.json({ task: wireTask(changed.task) } satisfies CrmTaskResponse);
  })

  .delete("/tasks/:id", async (c) => {
    const deleted = await memberCrm(c).deleteTask(c.req.param("id"));
    if (deleted.status !== "ok") return refused(c, deleted);
    await announceTask(c, deleted.task);
    return c.body(null, 204);
  });
