// Helpdesk conversation routes (ADR 0021): status, assignee, priority and tags of a shared
// inbox's conversations, and each inbox's tag list. Every change goes through
// `applyConversationChange` in `@omni/db`, which writes the change and its timeline event in one
// transaction and queues the IMAP filing (archive on resolve, back to INBOX on reopen).
import {
  applyConversationChange,
  CONVERSATION_VIEWS,
  createNote,
  createTag,
  deleteNote,
  deleteTag,
  markNotificationsRead,
  NOTE_MAX_LENGTH,
  updateNote,
  forMember,
  PRIORITIES,
  updateTag,
  type ChangeResult,
  type ConversationChange,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { pingMailService } from "../mail-service.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { fanOut } from "../realtime.ts";
import { zValidator } from "../validator.ts";

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
const newTagBody = z.object({ name: z.string().trim().min(1).max(64), color: tagColor.optional() });
const tagPatchBody = z
  .object({ name: z.string().trim().min(1).max(64).optional(), color: tagColor.optional() })
  .refine((patch) => patch.name !== undefined || patch.color !== undefined, "nothing to change");

const failures = {
  not_found: [404, "not found"],
  personal_mailbox: [409, "conversation actions are for shared inboxes"],
  not_assignable: [422, "that member cannot see this inbox"],
  unknown_tag: [422, "that tag is not one of this inbox's"],
  invalid_snooze: [422, "snooze until a time in the future"],
} as const;

function notFound(): never {
  throw new HTTPException(404, { message: "not found" });
}

/**
 * Applies `change` as this member, then tells the inbox's members and the mail service. A retry
 * under the same Idempotency-Key changes nothing once the first attempt did, so it cannot undo a
 * teammate's change made in between.
 */
async function applyChange(c: Context<AppEnv>, threadId: string, change: ConversationChange) {
  const result: ChangeResult = await applyConversationChange(c.var.db, {
    threadId,
    actorMemberId: c.var.member.id,
    change,
    requestId: c.var.requestId,
    idempotencyKey: c.req.header("idempotency-key"),
  });
  if (!result.ok) {
    const [status, message] = failures[result.reason];
    throw new HTTPException(status, { message });
  }
  if (result.queuedActions > 0) c.executionCtx.waitUntil(pingMailService(c.var));
  if (result.changed) {
    const { mailboxId, id } = result.conversation;
    c.executionCtx.waitUntil(
      fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
    );
  }
  return c.json({ conversation: result.conversation, changed: result.changed });
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

  /** Assign to the member asking. */
  .post("/threads/:id/claim", ...writeGuards, (c) =>
    applyChange(c, c.req.param("id"), { type: "assign", memberId: c.var.member.id }),
  )

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
      const { mailboxId, id } = result.conversation;
      c.executionCtx.waitUntil(
        fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
      );
      return c.json({ note: result.note, notified: result.notified }, 201);
    },
  )

  /** The author edits their own note. */
  .patch("/notes/:id", zValidator("json", notePatchBody), async (c) => {
    const note = await updateNote(c.var.db, {
      noteId: c.req.param("id"),
      memberId: c.var.member.id,
      body: c.req.valid("json").body,
    });
    if (!note) notFound();
    return c.json({ note });
  })

  /** The author deletes their own note. */
  .delete("/notes/:id", async (c) => {
    const note = await deleteNote(c.var.db, {
      noteId: c.req.param("id"),
      memberId: c.var.member.id,
    });
    if (!note) notFound();
    c.executionCtx.waitUntil(
      fanOut(c.env, c.var.db, c.var.config, new Map([[note.mailboxId, new Set([note.threadId])]])),
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
