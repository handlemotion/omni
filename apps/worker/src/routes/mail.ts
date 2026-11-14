// Member-facing mail routes. Reads go only through `forMember` and the member-scoped helpers in
// `@omni/db`; changes that must reach IMAP/SMTP are written to the outbox and the mail service
// is pinged. The Worker never holds mail credentials.
import {
  enqueueAction,
  forMember,
  forUser,
  LANES,
  listMemberMailboxes,
  THREAD_VIEWS,
  threadActionTargets,
  type MailActionRequest,
  type MemberQueries,
} from "@omni/db";
import { addedParticipants, messageDisplay } from "@omni/mail-core/display";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { pingMailService } from "../mail-service.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { smartSearch } from "../search.ts";
import { attachmentResponse } from "./assets.ts";
import {
  archiveThread,
  enqueuePerFolder as queuePerFolder,
  markRead,
  type ThreadWriter,
} from "../thread-writes.ts";
import { zValidator } from "../validator.ts";

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

/**
 * `workspace` (default): the active organization's member. `all`: every organization the user
 * belongs to, each row read as their member there (ADR 0014).
 */
const scopeParam = z.enum(["workspace", "all"]).default("workspace");

/** The read path for `scope`. */
function reader(c: Context<AppEnv>, scope: z.infer<typeof scopeParam>) {
  return scope === "all"
    ? forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId)
    : forMember(c.var.db, c.var.member.id);
}

const listQuery = z.object({
  scope: scopeParam,
  mailboxId: z.string().min(1).optional(),
  lane: z.enum(LANES).optional(),
  /** `inbox`, `later`, `done`, `archive` or `all`; see `ThreadView` in `@omni/db`. */
  view: z
    .enum([...THREAD_VIEWS, "queue"])
    // Deprecated: `queue` is Later's old name, still sent by tabs open from before ADR 0027.
    .transform((view) => (view === "queue" ? "later" : view))
    .default("inbox"),
  cursor: cursorParam,
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const searchQuery = z.object({
  scope: scopeParam,
  q: z.string().trim().min(1).max(500),
  mailboxId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const stateBody = z.object({ read: z.boolean() });

/** The thread's `lastMessageAt` as the client showed it: done covers what the member saw. */
const doneBody = z.object({ through: z.iso.datetime() });

const deferBody = z.object({ until: z.iso.datetime() });

const moveBody = z.object({ destination: z.string().min(1).max(1000) });

export const idempotencyHeader = z.object({
  "idempotency-key": z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, "8-128 URL-safe characters"),
});

/** Outbox keys are namespaced by member so one member's key can never reach another's action. */
export function outboxKey(c: Context<AppEnv>, key: string, ...parts: string[]) {
  return [c.var.member.id, key, ...parts].join(":");
}

export function notFound(): never {
  throw new HTTPException(404, { message: "not found" });
}

export function pingLater(c: Context<AppEnv>) {
  c.executionCtx.waitUntil(pingMailService(c.var));
}

/** Where an action runs: the mailbox it acts on and that mailbox's org. */
export interface ActionMailbox {
  orgId: string;
  mailboxId: string;
}

/** Queues one action for this member's request. A repeated idempotency key returns the first. */
export function enqueue(
  c: Context<AppEnv>,
  mailbox: ActionMailbox,
  request: MailActionRequest,
  idempotencyKey: string,
) {
  return enqueueAction(c.var.db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.mailboxId,
    memberId: c.var.member.id,
    requestId: c.var.requestId,
    idempotencyKey,
    ...request,
  });
}

/** Who a route's thread writes act as: this request's member. */
export function writerOf(c: Context<AppEnv>): ThreadWriter {
  return { db: c.var.db, memberId: c.var.member.id, requestId: c.var.requestId };
}

/**
 * Queues actions that each target one folder's copies, keyed by kind and folder so a retry under
 * the same idempotency key queues nothing new, and pings the mail service when any was queued.
 */
export async function enqueuePerFolder(
  c: Context<AppEnv>,
  mailbox: ActionMailbox,
  key: string,
  requests: Exclude<MailActionRequest, { kind: "send" }>[],
) {
  const actionIds = await queuePerFolder(writerOf(c), mailbox, key, requests);
  if (actionIds.length) pingLater(c);
  return actionIds;
}

/**
 * The thread as both views read it: chat mode uses `cleanText`, `fromMe`, `fromTeam`, `display`
 * and `addedParticipants`; email mode uses `hasHtml` and the HTML route. Storage keys stay inside.
 *
 * `fromTeam`: sent from this mailbox's address. `fromMe`: sent by the reader. On a personal
 * mailbox the two are the same; on a shared inbox only the replies the reader sent from Omni are
 * theirs (`sentByMemberId`), and a teammate's (or one sent from another mail app) is the team's.
 */
function threadResponse(
  thread: NonNullable<Awaited<ReturnType<MemberQueries["getThread"]>>>,
  memberId: string,
) {
  const self = thread.mailboxAddress.toLowerCase();
  const added = addedParticipants(thread.messages);
  return {
    ...thread,
    messages: thread.messages.map(({ r2Key: _raw, htmlR2Key, attachments, ...message }, i) => {
      const fromTeam = message.fromAddress.toLowerCase() === self;
      return {
        ...message,
        fromTeam,
        fromMe:
          fromTeam && (thread.mailboxKind === "personal" || message.sentByMemberId === memberId),
        display: messageDisplay(message.cleanText),
        hasHtml: htmlR2Key !== null,
        addedParticipants: added[i] ?? [],
        attachments: attachments.map(({ r2Key: _key, ...file }) => file),
      };
    }),
  };
}

export const mail = new Hono<AppEnv>()
  // `?scope=all`: every mailbox the user can open, in every workspace their session reaches
  // (ADR 0024), each with its `orgId`; the default is the active workspace's, as before.
  .get("/mailboxes", async (c) => {
    if (c.req.query("scope") === "all") {
      const reader = forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId);
      return c.json({ mailboxes: await reader.listMailboxes() });
    }
    return c.json({ mailboxes: await listMemberMailboxes(c.var.db, c.var.member.id) });
  })

  .get("/threads", zValidator("query", listQuery), async (c) => {
    const { cursor, scope, ...query } = c.req.valid("query");
    const threads = await reader(c, scope).listThreads({
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
    return c.json(threadResponse(thread, c.var.member.id));
  })

  /** Per mailbox: inbox and unread inbox threads, queued threads, and inbox threads per lane. */
  .get("/counts", zValidator("query", z.object({ scope: scopeParam })), async (c) => {
    return c.json({ counts: await reader(c, c.req.valid("query").scope).counts() });
  })

  /**
   * An outbox action's state, e.g. to learn after a reconnect whether a send failed. Any of the
   * user's members' actions: a reply sent from another workspace's thread is checked here too.
   */
  .get("/actions/:id", async (c) => {
    const action = await forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId).getAction(
      c.req.param("id"),
    );
    if (!action) notFound();
    return c.json(action);
  })

  /**
   * One row per thread, best first: the matching message's subject, sender and date, a snippet
   * around the match, and the thread's mailbox. `ranking` says whether Jev ordered them (`jev`)
   * or full-text relevance did (`text`: no TypeSafe key, or Jev failed or was slow).
   */
  .get("/search", limitPerMember("search"), zValidator("query", searchQuery), async (c) => {
    const { q, scope, ...options } = c.req.valid("query");
    const { hits, ranking } = await smartSearch(reader(c, scope), c.var.config, q, {
      ...options,
      log: c.var.log,
    });
    return c.json({
      results: hits.map(({ excerpt: _excerpt, score: _score, ...hit }) => hit),
      ranking,
    });
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
   * Read state is per member and lives in Postgres. On a personal mailbox it also syncs to the
   * IMAP \Seen flag; a shared mailbox never changes it (spec: "Sync rules").
   */
  .patch(
    "/threads/:id/state",
    limitPerMember("actions"),
    zValidator("header", idempotencyHeader),
    zValidator("json", stateBody),
    async (c) => {
      const { read } = c.req.valid("json");
      const key = c.req.valid("header")["idempotency-key"];
      const marked = await markRead(writerOf(c), c.req.param("id"), read, key);
      if (!marked) notFound();
      const { state, actionIds } = marked;
      if (actionIds.length) pingLater(c);
      return c.json({ state, actionIds });
    },
  )

  // Done and Later are this member's triage state (ADR 0007, ADR 0027): Postgres only, nothing
  // for the outbox, so another member of a shared mailbox is unaffected. Each request sets
  // absolute values, so a retry under the same idempotency key writes the same row. Done and
  // Later exclude each other: marking one clears the other.

  /**
   * Done through `through` (capped at the newest message). Answers `done: false` when a message
   * newer than `through` has arrived: the thread stays in the Inbox.
   */
  .post(
    "/threads/:id/done",
    zValidator("header", idempotencyHeader),
    zValidator("json", doneBody),
    async (c) => {
      const { through } = c.req.valid("json");
      const state = await forMember(c.var.db, c.var.member.id).setThreadState(c.req.param("id"), {
        doneThrough: new Date(through),
        later: false,
      });
      if (!state) notFound();
      return c.json({ state });
    },
  )

  /** Not done: back in the Inbox. */
  .delete("/threads/:id/done", zValidator("header", idempotencyHeader), async (c) => {
    const state = await forMember(c.var.db, c.var.member.id).setThreadState(c.req.param("id"), {
      doneThrough: null,
    });
    if (!state) notFound();
    return c.json({ state });
  })

  /** Into Later: out of the Inbox until the member moves it back (or marks it done). */
  .post("/threads/:id/later", zValidator("header", idempotencyHeader), async (c) => {
    const state = await forMember(c.var.db, c.var.member.id).setThreadState(c.req.param("id"), {
      later: true,
      doneThrough: null,
    });
    if (!state) notFound();
    return c.json({ state });
  })

  /** Out of Later: back in the Inbox. */
  .delete("/threads/:id/later", zValidator("header", idempotencyHeader), async (c) => {
    const state = await forMember(c.var.db, c.var.member.id).setThreadState(c.req.param("id"), {
      later: false,
    });
    if (!state) notFound();
    return c.json({ state });
  })

  /** Deprecated (ADR 0027): the timed deferral, for tabs open from before Later. */
  .post(
    "/threads/:id/defer",
    zValidator("header", idempotencyHeader),
    zValidator("json", deferBody),
    async (c) => {
      const { until } = c.req.valid("json");
      const state = await forMember(c.var.db, c.var.member.id).setThreadState(c.req.param("id"), {
        deferredUntil: new Date(until),
        doneThrough: null,
      });
      if (!state) notFound();
      return c.json({ state });
    },
  )

  /** Deprecated (ADR 0027): out of Later, for tabs open from before it. */
  .delete("/threads/:id/defer", zValidator("header", idempotencyHeader), async (c) => {
    const state = await forMember(c.var.db, c.var.member.id).setThreadState(c.req.param("id"), {
      deferredUntil: null,
    });
    if (!state) notFound();
    return c.json({ state });
  })

  .post(
    "/threads/:id/archive",
    limitPerMember("actions"),
    zValidator("header", idempotencyHeader),
    async (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      const archived = await archiveThread(writerOf(c), c.req.param("id"), key);
      if (!archived) notFound();
      const { actionIds } = archived;
      if (actionIds.length) pingLater(c);
      return c.json({ actionIds });
    },
  )

  .post(
    "/threads/:id/move",
    limitPerMember("actions"),
    zValidator("header", idempotencyHeader),
    zValidator("json", moveBody),
    async (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      const { destination } = c.req.valid("json");
      const found = await threadActionTargets(c.var.db, c.var.member.id, c.req.param("id"));
      if (!found) notFound();

      const actionIds = await enqueuePerFolder(
        c,
        found,
        key,
        found.targets
          .filter(({ folder }) => folder !== destination)
          .map(({ role: _role, ...target }) => ({
            kind: "move",
            payload: { ...target, destination },
          })),
      );
      return c.json({ actionIds });
    },
  );
