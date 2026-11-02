// Member-facing mail routes. Reads go only through `forMember` and the member-scoped helpers in
// `@omni/db`; changes that must reach IMAP/SMTP are written to the outbox and the mail service
// is pinged. The Worker never holds mail credentials.
import { zValidator } from "@hono/zod-validator";
import {
  enqueueAction,
  forMember,
  LANES,
  listMemberMailboxes,
  setThreadArchived,
  threadActionTargets,
  type MemberQueries,
} from "@omni/db";
import type { ActionPayload, SendPayload } from "@omni/contracts";
import { addedParticipants, messageDisplay } from "@omni/mail-core/display";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { pingMailService } from "../mail-service.ts";
import { attachmentResponse } from "./assets.ts";

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.string().min(1) });

function encodeCursor(thread: { lastMessageAt: Date; id: string }) {
  return btoa(JSON.stringify({ t: thread.lastMessageAt.toISOString(), id: thread.id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const cursorParam = z
  .string()
  .transform((value, ctx) => {
    try {
      const json = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
      const parsed = cursorSchema.parse(JSON.parse(json));
      return { lastMessageAt: new Date(parsed.t), id: parsed.id };
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid cursor" });
      return z.NEVER;
    }
  })
  .optional();

const listQuery = z.object({
  mailboxId: z.string().min(1).optional(),
  lane: z.enum(LANES).optional(),
  /** `inbox` hides snoozed threads until their time; `snoozed` lists them. */
  view: z.enum(["inbox", "snoozed", "archive"]).default("inbox"),
  cursor: cursorParam,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  mailboxId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const stateBody = z
  .object({ read: z.boolean().optional(), snoozedUntil: z.iso.datetime().nullable().optional() })
  .refine((b) => b.read !== undefined || b.snoozedUntil !== undefined, "nothing to change");

const address = z.email();
const sendBody = z.object({
  mailboxId: z.string().min(1),
  to: z.array(address).min(1).max(100),
  cc: z.array(address).max(100).optional(),
  bcc: z.array(address).max(100).optional(),
  subject: z.string().max(998),
  text: z.string().max(1_000_000),
  html: z.string().max(2_000_000).optional(),
});

const replyBody = z.object({
  text: z.string().min(1).max(1_000_000),
  html: z.string().max(2_000_000).optional(),
  replyAll: z.boolean().default(false),
});

const moveBody = z.object({ destination: z.string().min(1).max(1000) });

const idempotencyHeader = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, "8-128 URL-safe characters"),
});

/** Outbox keys are namespaced by member so one member's key can never reach another's action. */
function outboxKey(c: Context<AppEnv>, key: string, ...parts: string[]) {
  return [c.var.member.id, key, ...parts].join(":");
}

function notFound(): never {
  throw new HTTPException(404, { message: "not found" });
}

function pingLater(c: Context<AppEnv>) {
  c.executionCtx.waitUntil(pingMailService(c.var.config));
}

/**
 * The thread as both views read it: chat mode uses `cleanText`, `fromMe`, `display` and
 * `addedParticipants`; email mode uses `hasHtml` and the HTML route. Storage keys stay inside.
 */
function threadResponse(thread: NonNullable<Awaited<ReturnType<MemberQueries["getThread"]>>>) {
  const self = thread.mailboxAddress.toLowerCase();
  const added = addedParticipants(thread.messages);
  return {
    ...thread,
    messages: thread.messages.map(({ r2Key: _raw, htmlR2Key, attachments, ...message }, i) => ({
      ...message,
      fromMe: message.fromAddress.toLowerCase() === self,
      display: messageDisplay(message.cleanText),
      hasHtml: htmlR2Key !== null,
      addedParticipants: added[i] ?? [],
      attachments: attachments.map(({ r2Key: _key, ...file }) => file),
    })),
  };
}

/**
 * A retried request finds the action it already wrote, so it answers with that send's
 * Message-ID, not the fresh one it just made. The thread's message carries the same id once
 * the mail service files the Sent copy.
 */
function sendResponse(action: { id: string; payload: Record<string, unknown> }) {
  return {
    actionId: action.id,
    messageIdHeader: (action.payload as SendPayload).messageId ?? null,
  };
}

/** Chosen here so send and reply can return it before the mail goes out. */
function newMessageId(address: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return `<${crypto.randomUUID()}@${domain}>`;
}

export const mail = new Hono<AppEnv>()
  .get("/mailboxes", async (c) => {
    return c.json({ mailboxes: await listMemberMailboxes(c.var.db, c.var.member.id) });
  })

  .get("/threads", zValidator("query", listQuery), async (c) => {
    const { cursor, ...query } = c.req.valid("query");
    const threads = await forMember(c.var.db, c.var.member.id).listThreads({
      ...query,
      before: cursor,
    });
    const last = threads.at(-1);
    return c.json({
      threads,
      nextCursor: last && threads.length === query.limit ? encodeCursor(last) : null,
    });
  })

  .get("/threads/:id", async (c) => {
    const thread = await forMember(c.var.db, c.var.member.id).getThread(c.req.param("id"));
    if (!thread) notFound();
    return c.json(threadResponse(thread));
  })

  /** Per mailbox: inbox and unread inbox threads, snoozed threads, and inbox threads per lane. */
  .get("/counts", async (c) => {
    return c.json({ counts: await forMember(c.var.db, c.var.member.id).counts() });
  })

  /** An outbox action's state, e.g. to learn after a reconnect whether a send failed. */
  .get("/actions/:id", async (c) => {
    const action = await forMember(c.var.db, c.var.member.id).getAction(c.req.param("id"));
    if (!action) notFound();
    return c.json(action);
  })

  .get("/search", zValidator("query", searchQuery), async (c) => {
    const { q, ...options } = c.req.valid("query");
    return c.json({ results: await forMember(c.var.db, c.var.member.id).search(q, options) });
  })

  .get("/threads/:id/attachments/:attachmentId", async (c) => {
    const thread = await forMember(c.var.db, c.var.member.id).getThread(c.req.param("id"));
    const file = thread?.messages
      .flatMap((m) => m.attachments)
      .find((a) => a.id === c.req.param("attachmentId"));
    if (!file) notFound();
    const object = await c.env.MAIL_BUCKET.get(file.r2Key);
    if (!object) notFound();
    return attachmentResponse(object, file);
  })

  /**
   * Read and snooze state is per member and lives in Postgres. On a personal mailbox, read also
   * syncs to the IMAP \Seen flag; a shared mailbox never changes it (spec: "Sync rules").
   */
  .patch(
    "/threads/:id/state",
    zValidator("header", idempotencyHeader),
    zValidator("json", stateBody),
    async (c) => {
      const body = c.req.valid("json");
      const key = c.req.valid("header")["idempotency-key"];
      const threadId = c.req.param("id");
      const state = await forMember(c.var.db, c.var.member.id).setThreadState(threadId, {
        read: body.read,
        snoozedUntil:
          body.snoozedUntil === undefined
            ? undefined
            : body.snoozedUntil === null
              ? null
              : new Date(body.snoozedUntil),
      });
      if (!state) notFound();

      const actionIds: string[] = [];
      if (body.read !== undefined) {
        const found = await threadActionTargets(c.var.db, c.var.member.id, threadId);
        if (found?.mailboxKind === "personal") {
          const kind = body.read ? "mark_read" : "mark_unread";
          for (const { role: _role, ...target } of found.targets) {
            const action = await enqueueAction(c.var.db, {
              orgId: found.orgId,
              mailboxId: found.mailboxId,
              memberId: c.var.member.id,
              kind,
              payload: target,
              idempotencyKey: outboxKey(c, key, kind, target.folder),
            });
            actionIds.push(action.id);
          }
          if (actionIds.length) pingLater(c);
        }
      }
      return c.json({ state, actionIds });
    },
  )

  .post("/threads/:id/archive", zValidator("header", idempotencyHeader), async (c) => {
    const key = c.req.valid("header")["idempotency-key"];
    const threadId = c.req.param("id");
    const found = await threadActionTargets(c.var.db, c.var.member.id, threadId);
    if (!found) notFound();
    await setThreadArchived(c.var.db, c.var.member.id, threadId, true);

    const actionIds: string[] = [];
    for (const { role, ...target } of found.targets) {
      if (role === "archive" || role === "trash") continue;
      const action = await enqueueAction(c.var.db, {
        orgId: found.orgId,
        mailboxId: found.mailboxId,
        memberId: c.var.member.id,
        kind: "archive",
        payload: target,
        idempotencyKey: outboxKey(c, key, "archive", target.folder),
      });
      actionIds.push(action.id);
    }
    if (actionIds.length) pingLater(c);
    return c.json({ actionIds });
  })

  .post(
    "/threads/:id/move",
    zValidator("header", idempotencyHeader),
    zValidator("json", moveBody),
    async (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      const { destination } = c.req.valid("json");
      const found = await threadActionTargets(c.var.db, c.var.member.id, c.req.param("id"));
      if (!found) notFound();

      const actionIds: string[] = [];
      for (const { role: _role, ...target } of found.targets) {
        if (target.folder === destination) continue;
        const action = await enqueueAction(c.var.db, {
          orgId: found.orgId,
          mailboxId: found.mailboxId,
          memberId: c.var.member.id,
          kind: "move",
          payload: { ...target, destination } satisfies ActionPayload<"move">,
          idempotencyKey: outboxKey(c, key, "move", target.folder),
        });
        actionIds.push(action.id);
      }
      if (actionIds.length) pingLater(c);
      return c.json({ actionIds });
    },
  )

  .post(
    "/send",
    zValidator("header", idempotencyHeader),
    zValidator("json", sendBody),
    async (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      const { mailboxId, ...message } = c.req.valid("json");
      const mailboxes = await listMemberMailboxes(c.var.db, c.var.member.id);
      const mailbox = mailboxes.find((m) => m.id === mailboxId);
      if (!mailbox) notFound();
      const action = await enqueueAction(c.var.db, {
        orgId: mailbox.orgId,
        mailboxId: mailbox.id,
        memberId: c.var.member.id,
        kind: "send",
        payload: {
          from: mailbox.address,
          ...message,
          messageId: newMessageId(mailbox.address),
        } satisfies SendPayload,
        idempotencyKey: outboxKey(c, key, "send"),
      });
      pingLater(c);
      return c.json(sendResponse(action), 202);
    },
  )

  /** Replies to the latest message, with In-Reply-To and References so it threads everywhere. */
  .post(
    "/threads/:id/reply",
    zValidator("header", idempotencyHeader),
    zValidator("json", replyBody),
    async (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      const { text, html, replyAll } = c.req.valid("json");
      const threadId = c.req.param("id");
      const [thread, found] = await Promise.all([
        forMember(c.var.db, c.var.member.id).getThread(threadId),
        threadActionTargets(c.var.db, c.var.member.id, threadId),
      ]);
      const latest = thread?.messages.at(-1);
      if (!thread || !found || !latest) notFound();

      const self = found.mailboxAddress.toLowerCase();
      const isSelf = (a: string) => a.toLowerCase() === self;
      // Replying after our own message continues to the same people.
      const fromUs = isSelf(latest.fromAddress);
      const to = fromUs ? latest.to.map((a) => a.address) : [latest.fromAddress];
      const cc = replyAll
        ? [...(fromUs ? [] : latest.to), ...latest.cc]
            .map((a) => a.address)
            .filter((a) => !isSelf(a) && !to.includes(a))
        : [];
      const subject = /^re:/i.test(latest.subject) ? latest.subject : `Re: ${latest.subject}`;

      const action = await enqueueAction(c.var.db, {
        orgId: found.orgId,
        mailboxId: found.mailboxId,
        memberId: c.var.member.id,
        kind: "send",
        payload: {
          from: found.mailboxAddress,
          to,
          ...(cc.length ? { cc } : {}),
          subject,
          text,
          ...(html ? { html } : {}),
          inReplyTo: latest.messageIdHeader,
          references: [...latest.references, latest.messageIdHeader],
          messageId: newMessageId(found.mailboxAddress),
        } satisfies SendPayload,
        idempotencyKey: outboxKey(c, key, "send"),
      });
      pingLater(c);
      return c.json(sendResponse(action), 202);
    },
  );
