import {
  createTag,
  deleteBusinessHours,
  deleteSlaPolicy,
  deleteTag,
  forMember,
  MAX_ROLE_DESCRIPTION,
  PRIORITIES,
  putBusinessHours,
  putSlaPolicy,
  setAutoAssign,
  updateTag,
} from "@omni/db";
import type { BusinessHoursWindow } from "@omni/mail-core/business-hours";
import { isIanaZone } from "@omni/mail-core/calendar";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { notFound } from "../errors.ts";
import { managersOnly } from "../inbox-admin.ts";
import { zValidator } from "../validator.ts";

const tagColor = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .nullable();
const tagDescription = z.string().max(MAX_ROLE_DESCRIPTION);
const newTagBody = z.object({
  name: z.string().trim().min(1).max(64),
  color: tagColor.optional(),
  description: tagDescription.optional(),
});
const tagPatchBody = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    color: tagColor.optional(),
    description: tagDescription.optional(),
  })
  .refine(
    (patch) =>
      patch.name !== undefined || patch.color !== undefined || patch.description !== undefined,
    "nothing to change",
  );

const targetMinutes = z.number().int().min(1).max(525_600).nullable();
const slaPolicyBody = z.object({
  firstResponseMinutes: targetMinutes,
  nextResponseMinutes: targetMinutes,
  resolutionMinutes: targetMinutes,
  businessHoursOnly: z.boolean().default(true),
});
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "HH:MM");
const businessHoursBody = z.object({
  timezone: z.string().refine(isIanaZone, "an IANA time zone, e.g. America/Mexico_City"),
  windows: z
    .array(
      z
        .object({
          day: z
            .number()
            .int()
            .min(0)
            .max(6)
            .transform((d) => d as BusinessHoursWindow["day"]),
          start: clockTime,
          end: clockTime,
        })
        .refine((w) => w.start < w.end, "end after start"),
    )
    .max(70),
  holidays: z.array(z.iso.date()).max(400).default([]),
});

const autoAssignBody = z.object({ enabled: z.boolean() });
const DAY = 86_400_000;
const REPORT_MAX_DAYS = 92;
const reportQuery = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .transform(({ from, to }, ctx) => {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY);
    if (start >= end || end.getTime() - start.getTime() > REPORT_MAX_DAYS * DAY) {
      ctx.addIssue({ code: "custom", message: `from before to, at most ${REPORT_MAX_DAYS} days` });
      return z.NEVER;
    }
    return { from: start, to: end };
  });

const requireManager = managersOnly("only owners and admins change inbox settings");

function slaPriority(c: Context<AppEnv>) {
  const priority = z.enum(PRIORITIES).safeParse(c.req.param("priority"));
  return priority.success ? priority.data : notFound();
}

/** A helpdesk inbox's settings: who it assigns, its SLA and business hours, tags and report. */
export const inboxSettings = new Hono<AppEnv>()
  .get("/mailboxes/:id/assignees", async (c) => {
    const assignees = await forMember(c.var.db, c.var.member.id).mailboxAssignees(
      c.req.param("id"),
    );
    if (!assignees) notFound();
    return c.json({ assignees });
  })

  .get("/mailboxes/:id/sla", async (c) => {
    const settings = await forMember(c.var.db, c.var.member.id).slaSettings(c.req.param("id"));
    if (!settings) notFound();
    return c.json(settings);
  })

  .put(
    "/mailboxes/:id/sla/:priority",
    zValidator("json", slaPolicyBody),
    requireManager,
    async (c) => {
      const ok = await putSlaPolicy(
        c.var.db,
        c.var.member.orgId,
        c.req.param("id"),
        slaPriority(c),
        c.req.valid("json"),
      );
      if (!ok) notFound();
      return c.json({ ok: true as const });
    },
  )

  .delete("/mailboxes/:id/sla/:priority", requireManager, async (c) => {
    if (!(await deleteSlaPolicy(c.var.db, c.var.member.orgId, c.req.param("id"), slaPriority(c)))) {
      notFound();
    }
    return c.body(null, 204);
  })

  .put(
    "/mailboxes/:id/business-hours",
    zValidator("json", businessHoursBody),
    requireManager,
    async (c) => {
      const ok = await putBusinessHours(
        c.var.db,
        c.var.member.orgId,
        c.req.param("id"),
        c.req.valid("json"),
      );
      if (!ok) notFound();
      return c.json({ ok: true as const });
    },
  )

  .delete("/mailboxes/:id/business-hours", requireManager, async (c) => {
    if (!(await deleteBusinessHours(c.var.db, c.var.member.orgId, c.req.param("id")))) notFound();
    return c.body(null, 204);
  })

  .put(
    "/mailboxes/:id/auto-assign",
    zValidator("json", autoAssignBody),
    requireManager,
    async (c) => {
      const ok = await setAutoAssign(
        c.var.db,
        c.var.member.orgId,
        c.req.param("id"),
        c.req.valid("json").enabled,
      );
      if (!ok) notFound();
      return c.json({ ok: true as const });
    },
  )

  .get("/mailboxes/:id/report", zValidator("query", reportQuery), async (c) => {
    const range = c.req.valid("query");
    const report = await forMember(c.var.db, c.var.member.id).inboxReport(c.req.param("id"), range);
    if (!report) notFound();
    return c.json({ from: range.from.toISOString(), to: range.to.toISOString(), ...report });
  })

  .get("/mailboxes/:id/tags", async (c) => {
    const tags = await forMember(c.var.db, c.var.member.id).listTags(c.req.param("id"));
    if (!tags) notFound();
    return c.json({ tags });
  })

  .post("/mailboxes/:id/tags", zValidator("json", newTagBody), async (c) => {
    const result = await createTag(
      c.var.db,
      c.var.member.id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    if (!result) notFound();
    return c.json({ tag: result.tag }, result.created ? 201 : 200);
  })

  .patch("/mailboxes/:id/tags/:tagId", zValidator("json", tagPatchBody), async (c) => {
    const result = await updateTag(
      c.var.db,
      c.var.member.id,
      c.req.param("id"),
      c.req.param("tagId"),
      c.req.valid("json"),
    );
    if (result.status === "not_found") notFound();
    if (result.status === "conflict") {
      throw new HTTPException(409, { message: "another tag has that name" });
    }
    return c.json({ tag: result.tag });
  })

  .delete("/mailboxes/:id/tags/:tagId", async (c) => {
    const deleted = await deleteTag(
      c.var.db,
      c.var.member.id,
      c.req.param("id"),
      c.req.param("tagId"),
    );
    if (!deleted) notFound();
    return c.body(null, 204);
  });
