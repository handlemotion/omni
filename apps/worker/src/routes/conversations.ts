import {
  applyConversationChange,
  CONVERSATION_VIEWS,
  createNote,
  deleteNote,
  NOTE_MAX_LENGTH,
  updateNote,
  forMember,
  PRIORITIES,
  type ConversationChange,
} from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { pingMailService } from "../mail-service.ts";
import { limitPerMember } from "../rate-limiter.ts";
import {
  announceNote,
  fanOut,
  notifyMembers,
  withdrawNotifications,
} from "../realtime-announce.ts";
import { timePageCursor, timePageQuery } from "../cursor.ts";
import { zValidator, idempotencyHeader } from "../validator.ts";
import {
  applyChange,
  claimPrecondition,
  expectedAssignee,
  failures,
} from "./conversation-change.ts";
import { notFound } from "../errors.ts";

const listQuery = z.object({
  mailboxId: z.string().min(1),
  view: z.enum(CONVERSATION_VIEWS).default("open"),
  tagId: z.string().min(1).optional(),
  cursor: timePageQuery,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const noteBody = z.object({
  body: z.string().trim().min(1).max(NOTE_MAX_LENGTH),
  mentions: z.array(z.string().min(1)).max(50).default([]),
});
const notePatchBody = z.object({ body: z.string().trim().min(1).max(NOTE_MAX_LENGTH) });
const snoozeBody = z.object({ until: z.iso.datetime({ offset: true }) });
const assigneeBody = z.object({ memberId: z.string().min(1).nullable() });
const priorityBody = z.object({ priority: z.enum(PRIORITIES) });
const tagBody = z.object({ tagId: z.string().min(1) });
const bulkChange = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resolve") }),
  z.object({ type: z.literal("reopen") }),
  z.object({ type: z.literal("snooze"), until: z.iso.datetime({ offset: true }) }),
  z.object({ type: z.literal("claim"), expectedAssignee: expectedAssignee }),
  z.object({ type: z.literal("assign"), memberId: z.string().min(1).nullable() }),
  z.object({ type: z.literal("priority"), priority: z.enum(PRIORITIES) }),
  z.object({ type: z.literal("tag"), tagId: z.string().min(1), add: z.boolean() }),
]);
const bulkBody = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(100),
  change: bulkChange,
});
const domainChange: (change: z.infer<typeof bulkChange>, memberId: string) => ConversationChange = (
  change,
  memberId,
) => {
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
};

const writeGuards = [limitPerMember("actions"), zValidator("header", idempotencyHeader)] as const;

export const conversations = new Hono<AppEnv>()
  .get("/conversations", zValidator("query", listQuery), async (c) => {
    const { cursor, ...query } = c.req.valid("query");
    const rows = await forMember(c.var.db, c.var.member.id).listConversations({
      ...query,
      after: cursor,
    });
    const last = rows.at(-1);
    const nextCursor =
      last && rows.length === query.limit ? timePageCursor(last.pageAt, last.id) : null;
    return c.json({ conversations: rows.map(({ pageAt: _pageAt, ...row }) => row), nextCursor });
  })

  .get(
    "/conversations/counts",
    zValidator("query", z.object({ mailboxId: z.string().min(1).optional() })),
    async (c) =>
      c.json({
        counts: await forMember(c.var.db, c.var.member.id).conversationCounts(c.req.valid("query")),
      }),
  )

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

  .get("/threads/:id/conversation", async (c) => {
    const conversation = await forMember(c.var.db, c.var.member.id).getConversation(
      c.req.param("id"),
    );
    if (!conversation) notFound();
    return c.json(conversation);
  })

  .post("/threads/:id/resolve", ...writeGuards, (c) =>
    applyChange(c, c.req.param("id"), { type: "resolve" }),
  )

  .post("/threads/:id/reopen", ...writeGuards, (c) =>
    applyChange(c, c.req.param("id"), { type: "reopen" }),
  )

  .post("/threads/:id/snooze", ...writeGuards, zValidator("json", snoozeBody), (c) =>
    applyChange(c, c.req.param("id"), {
      type: "snooze",
      until: new Date(c.req.valid("json").until),
    }),
  )

  .post("/threads/:id/claim", ...writeGuards, async (c) => {
    const { expectedAssignee } = await claimPrecondition(c);
    return applyChange(c, c.req.param("id"), {
      type: "assign",
      memberId: c.var.member.id,
      ...(expectedAssignee !== undefined ? { expectedAssignee } : {}),
    });
  })

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
          notifyMembers(c.env, c.var.db, {
            orgId,
            threadId: id,
            memberIds: result.followed,
            kind: "note",
          }),
        ]),
      );
      return c.json({ note: result.note, notified: result.notified }, 201);
    },
  )

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
        withdrawNotifications(c.env, {
          orgId: note.orgId,
          threadId: note.threadId,
          memberIds: note.notified,
        }),
      ]),
    );
    return c.body(null, 204);
  });
