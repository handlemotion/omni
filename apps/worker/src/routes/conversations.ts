// Helpdesk conversation routes (ADR 0021): status, assignee, priority and tags of a shared
// inbox's conversations, and each inbox's tag list. Every change goes through
// `applyConversationChange` in `@omni/db`, which writes the change and its timeline event in one
// transaction and queues the IMAP filing (archive on resolve, back to INBOX on reopen).
import {
  applyConversationChange,
  MAX_ROLE_DESCRIPTION,
  CONVERSATION_VIEWS,
  createNote,
  createTag,
  deleteBusinessHours,
  deleteNote,
  deleteSlaPolicy,
  deleteTag,
  markNotificationsRead,
  NOTE_MAX_LENGTH,
  updateNote,
  forMember,
  PRIORITIES,
  putBusinessHours,
  putSlaPolicy,
  setAutoAssign,
  updateTag,
  type ConversationChange,
} from "@omni/db";
import { isTimeZone, type BusinessHoursWindow } from "@omni/mail-core/business-hours";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { pingMailService } from "../mail-service.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { announceNote, fanOut, notifyMembers, withdrawNotifications } from "../realtime.ts";
import { zValidator } from "../validator.ts";
import {
  applyChange,
  claimPrecondition,
  expectedAssignee,
  failures,
} from "./conversation-change.ts";

const idempotencyHeader = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, "8-128 URL-safe characters"),
});

const cursorParam = z
  .string()
  .transform((value, ctx) => {
    try {
      const json = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
      const parsed = z.object({ t: z.iso.datetime(), id: z.string().min(1) }).parse(json);
      return { at: parsed.t, id: parsed.id };
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid cursor" });
      return z.NEVER;
    }
  })
  .optional();

function encodeCursor(at: string, id: string) {
  return btoa(JSON.stringify({ t: at, id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const listQuery = z.object({
  mailboxId: z.string().min(1),
  view: z.enum(CONVERSATION_VIEWS).default("open"),
  tagId: z.string().min(1).optional(),
  cursor: cursorParam,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const noteBody = z.object({
  body: z.string().trim().min(1).max(NOTE_MAX_LENGTH),
  /** `members.id` of everyone @mentioned; the client resolves names from `/assignees`. */
  mentions: z.array(z.string().min(1)).max(50).default([]),
});
const notePatchBody = z.object({ body: z.string().trim().min(1).max(NOTE_MAX_LENGTH) });
const notificationsQuery = z.object({
  unread: z.enum(["true", "false"]).default("false"),
  cursor: cursorParam,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const readBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500).optional() });

const snoozeBody = z.object({ until: z.iso.datetime({ offset: true }) });
const assigneeBody = z.object({ memberId: z.string().min(1).nullable() });
const priorityBody = z.object({ priority: z.enum(PRIORITIES) });
const tagBody = z.object({ tagId: z.string().min(1) });
/** A design-system token name (`accent`, `amber`), never a raw color. */
const tagColor = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .nullable();
/** What the team files under a tag (ADR 0033); triage reads it. Blank clears it. */
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

/** A target in minutes, up to a year; null leaves it untracked. */
const targetMinutes = z.number().int().min(1).max(525_600).nullable();
const slaPolicyBody = z.object({
  firstResponseMinutes: targetMinutes,
  nextResponseMinutes: targetMinutes,
  resolutionMinutes: targetMinutes,
  businessHoursOnly: z.boolean().default(true),
});
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "HH:MM");
const businessHoursBody = z.object({
  timezone: z.string().refine(isTimeZone, "an IANA time zone, e.g. America/Mexico_City"),
  windows: z
    .array(
      z
        .object({
          /** 0 is Sunday. */
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

/** One change for many conversations; `claim` assigns each to the member asking. */
const bulkChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resolve") }),
  z.object({ type: z.literal("reopen") }),
  z.object({ type: z.literal("snooze"), until: z.iso.datetime({ offset: true }) }),
  /** With `expectedAssignee`, each is claimed only if still assigned that way (see claim). */
  z.object({ type: z.literal("claim"), expectedAssignee: expectedAssignee }),
  z.object({ type: z.literal("assign"), memberId: z.string().min(1).nullable() }),
  z.object({ type: z.literal("priority"), priority: z.enum(PRIORITIES) }),
  z.object({ type: z.literal("tag"), tagId: z.string().min(1), add: z.boolean() }),
]);
const bulkBody = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(100),
  change: bulkChange,
});
const autoAssignBody = z.object({ enabled: z.boolean() });
const DAY = 86_400_000;
/** A report covers at most this many days. */
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

function domainChange(change: z.infer<typeof bulkChange>, memberId: string): ConversationChange {
  switch (change.type) {
    case "snooze":
      return { type: "snooze", until: new Date(change.until) };
    case "claim":
      return change.expectedAssignee === undefined
        ? { type: "assign", memberId }
        : { type: "assign", memberId, expectedAssignee: change.expectedAssignee };
    default:
      return change;
  }
}

/** Owners and admins change inbox settings. Better Auth stores several roles as a comma list. */
function requireManager(c: Context<AppEnv>) {
  const { role } = c.var.member;
  if (!role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin")) {
    throw new HTTPException(403, { message: "only owners and admins change inbox settings" });
  }
}

function notFound(): never {
  throw new HTTPException(404, { message: "not found" });
}

const writeGuards = [limitPerMember("actions"), zValidator("header", idempotencyHeader)] as const;

export const conversations = new Hono<AppEnv>()
  /**
   * One shared inbox's conversations in a helpdesk view (`unassigned`, `mine`, `open`, `pending`,
   * `snoozed`, `resolved`, `sla_at_risk`, `all`), optionally only those tagged `tagId`. Newest
   * first; `sla_at_risk` soonest due first. `nextCursor` is null on the last page.
   */
  .get("/conversations", zValidator("query", listQuery), async (c) => {
    const { cursor, ...query } = c.req.valid("query");
    const rows = await forMember(c.var.db, c.var.member.id).listConversations({
      ...query,
      after: cursor,
    });
    const last = rows.at(-1);
    const nextCursor =
      last && rows.length === query.limit ? encodeCursor(last.pageAt, last.id) : null;
    return c.json({ conversations: rows.map(({ pageAt: _pageAt, ...row }) => row), nextCursor });
  })

  /** Per shared inbox: each view's count (not `resolved`) and open or pending ones per tag. */
  .get(
    "/conversations/counts",
    zValidator("query", z.object({ mailboxId: z.string().min(1).optional() })),
    async (c) =>
      c.json({
        counts: await forMember(c.var.db, c.var.member.id).conversationCounts(c.req.valid("query")),
      }),
  )

  /**
   * Applies one change to up to 100 conversations, each on its own (one failing does not stop the
   * rest), and answers each one's result in order. A retry under the same Idempotency-Key changes
   * nothing that the first attempt already changed.
   */
  .post("/conversations/bulk", ...writeGuards, zValidator("json", bulkBody), async (c) => {
    const { threadIds, change } = c.req.valid("json");
    const key = c.req.header("idempotency-key")!;
    const memberId = c.var.member.id;
    const results: (
      | { threadId: string; ok: true; changed: boolean }
      | { threadId: string; ok: false; error: string }
    )[] = [];
    const changed = new Map<string, Set<string>>();
    const assigned: { orgId: string; threadId: string; memberIds: string[] }[] = [];
    let queuedActions = 0;
    for (const threadId of new Set(threadIds)) {
      const result = await applyConversationChange(c.var.db, {
        threadId,
        actorMemberId: memberId,
        change: domainChange(change, memberId),
        requestId: c.var.requestId,
        // Per conversation, so a retry skips exactly the ones already done.
        idempotencyKey: `${key}:${threadId}`,
      });
      if (!result.ok) {
        results.push({ threadId, ok: false, error: failures[result.reason][1] });
        continue;
      }
      results.push({ threadId, ok: true, changed: result.changed });
      if (!result.changed) continue;
      const { mailboxId, id, orgId } = result.conversation;
      changed.set(mailboxId, (changed.get(mailboxId) ?? new Set()).add(id));
      queuedActions += result.queuedActions;
      if (result.notified.length)
        assigned.push({ orgId, threadId: id, memberIds: result.notified });
    }
    if (queuedActions > 0) c.executionCtx.waitUntil(pingMailService(c.var));
    if (changed.size) {
      c.executionCtx.waitUntil(
        Promise.all([
          fanOut(c.env, c.var.db, c.var.config, changed),
          ...assigned.map((a) => notifyMembers(c.env, c.var.db, { ...a, kind: "assigned" })),
        ]),
      );
    }
    return c.json({ results });
  })

  /** Status, assignee, priority, SLA due times, tags and the timeline events, oldest first. */
  .get("/threads/:id/conversation", async (c) => {
    const conversation = await forMember(c.var.db, c.var.member.id).getConversation(
      c.req.param("id"),
    );
    if (!conversation) notFound();
    return c.json(conversation);
  })

  /** Resolved: filed out of INBOX on the server; a customer reply reopens it. */
  .post("/threads/:id/resolve", ...writeGuards, (c) =>
    applyChange(c, c.req.param("id"), { type: "resolve" }),
  )

  /** Open again, its mail back in INBOX. */
  .post("/threads/:id/reopen", ...writeGuards, (c) =>
    applyChange(c, c.req.param("id"), { type: "reopen" }),
  )

  /** Out of Open until `until`; a customer reply wakes it sooner. */
  .post("/threads/:id/snooze", ...writeGuards, zValidator("json", snoozeBody), (c) =>
    applyChange(c, c.req.param("id"), {
      type: "snooze",
      until: new Date(c.req.valid("json").until),
    }),
  )

  /** Assign to the member asking; with `expectedAssignee`, only if no one else got there first. */
  .post("/threads/:id/claim", ...writeGuards, async (c) => {
    const { expectedAssignee } = await claimPrecondition(c);
    return applyChange(c, c.req.param("id"), {
      type: "assign",
      memberId: c.var.member.id,
      ...(expectedAssignee !== undefined ? { expectedAssignee } : {}),
    });
  })

  /** Assign to any member who can see the inbox, or `null` to unassign. */
  .put("/threads/:id/assignee", ...writeGuards, zValidator("json", assigneeBody), (c) =>
    applyChange(c, c.req.param("id"), { type: "assign", memberId: c.req.valid("json").memberId }),
  )

  .put("/threads/:id/priority", ...writeGuards, zValidator("json", priorityBody), (c) =>
    applyChange(c, c.req.param("id"), { type: "priority", priority: c.req.valid("json").priority }),
  )

  .post("/threads/:id/tags", ...writeGuards, zValidator("json", tagBody), (c) =>
    applyChange(c, c.req.param("id"), { type: "tag", tagId: c.req.valid("json").tagId, add: true }),
  )

  .delete("/threads/:id/tags/:tagId", ...writeGuards, (c) =>
    applyChange(c, c.req.param("id"), { type: "tag", tagId: c.req.param("tagId"), add: false }),
  )

  /** An internal note in the timeline; never sent. Each @mentioned teammate is notified. */
  .post(
    "/threads/:id/notes",
    limitPerMember("actions"),
    zValidator("json", noteBody),
    async (c) => {
      const result = await createNote(c.var.db, {
        threadId: c.req.param("id"),
        memberId: c.var.member.id,
        ...c.req.valid("json"),
      });
      if (!result.ok) {
        const [status, message] = failures[result.reason];
        throw new HTTPException(status, { message });
      }
      const { mailboxId, id, orgId } = result.conversation;
      c.executionCtx.waitUntil(
        Promise.all([
          fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
          announceNote(c.env, c.var.db, { orgId, mailboxId, threadId: id, noteId: result.note.id }),
          notifyMembers(c.env, c.var.db, {
            orgId,
            threadId: id,
            memberIds: result.notified,
            kind: "mention",
          }),
        ]),
      );
      return c.json({ note: result.note, notified: result.notified }, 201);
    },
  )

  /**
   * The author edits their own note. Under `/threads/:id`, so the member is the thread's
   * workspace's (a note opened from All mailboxes is in another workspace than the active one).
   */
  .patch("/threads/:id/notes/:noteId", zValidator("json", notePatchBody), async (c) => {
    const note = await updateNote(c.var.db, {
      threadId: c.req.param("id"),
      noteId: c.req.param("noteId"),
      memberId: c.var.member.id,
      body: c.req.valid("json").body,
    });
    if (!note) notFound();
    c.executionCtx.waitUntil(
      fanOut(c.env, c.var.db, c.var.config, new Map([[note.mailboxId, new Set([note.threadId])]])),
    );
    return c.json({ note });
  })

  /** The author deletes their own note. */
  .delete("/threads/:id/notes/:noteId", async (c) => {
    const note = await deleteNote(c.var.db, {
      threadId: c.req.param("id"),
      noteId: c.req.param("noteId"),
      memberId: c.var.member.id,
    });
    if (!note) notFound();
    c.executionCtx.waitUntil(
      Promise.all([
        fanOut(
          c.env,
          c.var.db,
          c.var.config,
          new Map([[note.mailboxId, new Set([note.threadId])]]),
        ),
        // Its mention notifications went with it: the mentioned refetch theirs.
        withdrawNotifications(c.env, {
          orgId: note.orgId,
          threadId: note.threadId,
          memberIds: note.mentions.filter((m) => m !== c.var.member.id),
        }),
      ]),
    );
    return c.body(null, 204);
  })

  /** The member's notifications, newest first, and how many are unread. */
  .get("/notifications", zValidator("query", notificationsQuery), async (c) => {
    const { unread, cursor, limit } = c.req.valid("query");
    const page = await forMember(c.var.db, c.var.member.id).listNotifications({
      unreadOnly: unread === "true",
      before: cursor,
      limit,
    });
    const last = page.notifications.at(-1);
    return c.json({
      unread: page.unread,
      notifications: page.notifications.map(({ pageAt: _pageAt, ...row }) => row),
      nextCursor:
        last && page.notifications.length === limit ? encodeCursor(last.pageAt, last.id) : null,
    });
  })

  /** Marks these notifications read, or every one without `ids`. */
  .post("/notifications/read", zValidator("json", readBody), async (c) => {
    const { ids } = c.req.valid("json");
    const marked = await markNotificationsRead(c.var.db, c.var.member.id, ids ?? "all");
    return c.json({ marked });
  })

  /** Who conversations in this inbox can be assigned to. */
  .get("/mailboxes/:id/assignees", async (c) => {
    const assignees = await forMember(c.var.db, c.var.member.id).mailboxAssignees(
      c.req.param("id"),
    );
    if (!assignees) notFound();
    return c.json({ assignees });
  })

  /** The inbox's SLA targets per priority and its business hours (null: always open). */
  .get("/mailboxes/:id/sla", async (c) => {
    const settings = await forMember(c.var.db, c.var.member.id).slaSettings(c.req.param("id"));
    if (!settings) notFound();
    return c.json(settings);
  })

  /**
   * Sets the inbox's targets for one priority. Open conversations' due times move to match; an
   * alert already sent for the old due time is not sent again for it.
   */
  .put("/mailboxes/:id/sla/:priority", zValidator("json", slaPolicyBody), async (c) => {
    requireManager(c);
    const priority = z.enum(PRIORITIES).safeParse(c.req.param("priority"));
    if (!priority.success) notFound();
    const ok = await putSlaPolicy(
      c.var.db,
      c.var.member.orgId,
      c.req.param("id"),
      priority.data,
      c.req.valid("json"),
    );
    if (!ok) notFound();
    return c.json({ ok: true as const });
  })

  /** Stops tracking SLAs for one priority. */
  .delete("/mailboxes/:id/sla/:priority", async (c) => {
    requireManager(c);
    const priority = z.enum(PRIORITIES).safeParse(c.req.param("priority"));
    if (!priority.success) notFound();
    if (!(await deleteSlaPolicy(c.var.db, c.var.member.orgId, c.req.param("id"), priority.data))) {
      notFound();
    }
    return c.body(null, 204);
  })

  /** When the inbox is staffed; SLA targets with `businessHoursOnly` count only these hours. */
  .put("/mailboxes/:id/business-hours", zValidator("json", businessHoursBody), async (c) => {
    requireManager(c);
    const ok = await putBusinessHours(
      c.var.db,
      c.var.member.orgId,
      c.req.param("id"),
      c.req.valid("json"),
    );
    if (!ok) notFound();
    return c.json({ ok: true as const });
  })

  /** Back to always open. */
  .delete("/mailboxes/:id/business-hours", async (c) => {
    requireManager(c);
    if (!(await deleteBusinessHours(c.var.db, c.var.member.orgId, c.req.param("id")))) notFound();
    return c.body(null, 204);
  })

  /**
   * Round-robin auto-assign for the inbox: each new conversation from a customer goes to the next
   * member who can see it, in turn.
   */
  .put("/mailboxes/:id/auto-assign", zValidator("json", autoAssignBody), async (c) => {
    requireManager(c);
    const ok = await setAutoAssign(
      c.var.db,
      c.var.member.orgId,
      c.req.param("id"),
      c.req.valid("json").enabled,
    );
    if (!ok) notFound();
    return c.json({ ok: true as const });
  })

  /**
   * The inbox's report for `[from, to)` (default: the last 30 days): new conversations by
   * assignee and tag, first response and resolution times (count, median and p90 in seconds),
   * and who resolved them.
   */
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

  /** Creates a tag; the same name (ignoring case) answers the existing tag with 200. */
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

  /** Deletes the tag and takes it off every conversation. */
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
