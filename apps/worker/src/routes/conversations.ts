// Helpdesk conversation routes (ADR 0021): status, assignee, priority and tags of a shared
// inbox's conversations, and each inbox's tag list. Every change goes through
// `applyConversationChange` in `@omni/db`, which writes the change and its timeline event in one
// transaction and queues the IMAP filing (archive on resolve, back to INBOX on reopen).
import {
  applyConversationChange,
  createTag,
  deleteTag,
  forMember,
  listTags,
  mailboxAssignees,
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
 * changes nothing (each change sets an absolute value, and filing is keyed by the transition),
 * so the idempotency key only has to be well formed.
 */
async function applyChange(c: Context<AppEnv>, threadId: string, change: ConversationChange) {
  const result: ChangeResult = await applyConversationChange(c.var.db, {
    threadId,
    actorMemberId: c.var.member.id,
    change,
    requestId: c.var.requestId,
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

  /** Who conversations in this inbox can be assigned to. */
  .get("/mailboxes/:id/assignees", async (c) => {
    const assignees = await mailboxAssignees(c.var.db, c.var.member.id, c.req.param("id"));
    if (!assignees) notFound();
    return c.json({ assignees });
  })

  .get("/mailboxes/:id/tags", async (c) => {
    const tags = await listTags(c.var.db, c.var.member.id, c.req.param("id"));
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
