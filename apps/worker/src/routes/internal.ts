// Calls from the mail service. Each is HMAC-signed with a timestamp and a nonce; the nonce is
// claimed in the ReplayGuard Durable Object, so a request is accepted once at most.
import { DEFAULT_MAX_AGE_SECONDS, verifyRequest } from "@omni/crypto";
import {
  MAIL_EVENTS_PATH,
  MAX_EVENTS_PER_REQUEST,
  mailEventSchema,
  type MailEvent,
} from "@omni/contracts";
import { applyInboundMessage, recordCustomer, resolveDiscarded } from "@omni/db";
import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { openDb } from "../db.ts";
import { loadConfig } from "../env.ts";
import { pingMailService } from "../mail-service.ts";
import type { AiJob } from "../queue.ts";
import { announceMerges, fanOut, notifyFailedActions, notifyMembers } from "../realtime.ts";

export const internal = new Hono<AppEnv>().post(MAIL_EVENTS_PATH, async (c) => {
  const config = loadConfig(c.env);
  const body = await c.req.text();
  const url = new URL(c.req.url);
  const verified = await verifyRequest({
    secret: config.MAIL_SERVICE_HMAC_SECRET,
    method: c.req.method,
    path: url.pathname + url.search,
    body,
    headers: c.req.raw.headers,
  });
  if (!verified.ok) return c.json({ error: verified.reason }, 401);
  if (!verified.nonce) return c.json({ error: "missing_nonce" }, 401);

  const guard = c.env.REPLAY_GUARD.get(c.env.REPLAY_GUARD.idFromName("mail-service"));
  // Keep the nonce until its timestamp could no longer pass verification.
  const expiresAt = (verified.timestamp + DEFAULT_MAX_AGE_SECONDS + 1) * 1000;
  if (!(await guard.claim(verified.nonce, expiresAt))) {
    return c.json({ error: "replayed" }, 401);
  }

  let parsed;
  try {
    parsed = envelope.safeParse(JSON.parse(body));
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  // Event types this Worker does not know yet are ignored (packages/contracts/AGENTS.md).
  const events: MailEvent[] = [];
  for (const raw of parsed.data.events) {
    if (!knownTypes.has(raw.type)) continue;
    const event = mailEventSchema.safeParse(raw);
    if (!event.success) return c.json({ error: "invalid event", issues: event.error.issues }, 400);
    events.push(event.data);
  }

  const log = c.var.log.child({ component: "internal" });
  const jobs = aiJobsFor(events, c.var.requestId);
  const failed = events.filter((e) => e.type === "action.failed");
  log.info("mail_events.received", { events: events.length, jobs: jobs.length });
  // The original request's ID, so a failed send traces back to the click that asked for it.
  for (const event of failed) {
    log.warn("action.failed", {
      actionId: event.actionId,
      orgId: event.orgId,
      mailboxId: event.mailboxId,
      actionRequestId: event.requestId ?? null,
    });
  }
  // A Queue takes at most 100 messages per `sendBatch`; one prune can name 500 threads.
  for (let i = 0; i < jobs.length; i += QUEUE_BATCH_MAX) {
    await c.env.AI_QUEUE.sendBatch(jobs.slice(i, i + QUEUE_BATCH_MAX).map((body) => ({ body })));
  }

  const { db, close } = openDb(c.env);
  try {
    const created = events.filter((e) => e.type === "message.created");
    for (const event of created) await recordCustomer(db, event);
    // The helpdesk status rule, once per message and in order (ADR 0021): a customer message
    // reopens, our own reply goes pending. A failure answers 500, so the mail service retries.
    let queuedActions = 0;
    // A replayed event (the mail service retries until we answer) is fanned out again, which is
    // harmless, but pushes only for mail seen here for the first time.
    const fresh = new Set<string>();
    for (const event of created) {
      const applied = await applyInboundMessage(db, {
        messageId: event.messageId,
        folderRole: event.folderRole,
      });
      if (applied.applied || applied.fresh) fresh.add(event.mailboxId);
      if (!applied.applied) continue;
      queuedActions += applied.queuedActions;
      await notifyMembers(c.env, db, {
        orgId: applied.conversation.orgId,
        threadId: applied.conversation.id,
        memberIds: applied.notified,
        kind: "customer_reply",
      });
      if (applied.autoAssigned) {
        await notifyMembers(c.env, db, {
          orgId: applied.conversation.orgId,
          threadId: applied.conversation.id,
          memberIds: [applied.autoAssigned],
          kind: "assigned",
        });
      }
    }
    if (queuedActions > 0)
      c.executionCtx.waitUntil(pingMailService({ config, log, requestId: c.var.requestId }));
    if (created.length) await fanOut(c.env, db, config, changedThreads(created), { push: fresh });
    // Deleted mail: open apps refetch those threads (some are gone); no push for a removal.
    const pruned = events.filter((e) => e.type === "messages.pruned");
    if (pruned.length) await fanOut(c.env, db, config, prunedThreads(pruned));
    // Merged threads: the survivor and the ids that are gone refresh, and readers follow.
    const merged = events.filter((e) => e.type === "threads.merged");
    if (merged.length) {
      await fanOut(c.env, db, config, mergedThreads(merged));
      await announceMerges(c.env, db, merged);
    }
    // Deleted or junked in another mail app: resolve what still qualifies, then refresh.
    const discarded = events.filter((e) => e.type === "threads.discarded");
    if (discarded.length) {
      const resolved = new Map<string, Set<string>>();
      for (const event of discarded) {
        for (const threadId of event.threadIds) {
          const result = await resolveDiscarded(db, { threadId });
          if (!result.changed) continue;
          const threads = resolved.get(event.mailboxId) ?? new Set();
          threads.add(threadId);
          resolved.set(event.mailboxId, threads);
        }
      }
      log.info("threads.discarded", {
        resolved: [...resolved.values()].reduce((n, t) => n + t.size, 0),
      });
      if (resolved.size) await fanOut(c.env, db, config, resolved);
    }
    await notifyFailedActions(c.env, failed);
  } finally {
    c.executionCtx.waitUntil(close());
  }
  return c.json({ ok: true, jobs: jobs.length }, 202);
});

const QUEUE_BATCH_MAX = 100;

const envelope = z.object({
  events: z
    .array(z.looseObject({ type: z.string() }))
    .min(1)
    .max(MAX_EVENTS_PER_REQUEST),
});
const knownTypes = new Set<string>(mailEventSchema.options.map((o) => o.shape.type.value));

function changedThreads(events: Extract<MailEvent, { type: "message.created" }>[]) {
  const byMailbox = new Map<string, Set<string>>();
  for (const event of events) {
    const threads = byMailbox.get(event.mailboxId) ?? new Set();
    threads.add(event.threadId);
    byMailbox.set(event.mailboxId, threads);
  }
  return byMailbox;
}

function prunedThreads(events: Extract<MailEvent, { type: "messages.pruned" }>[]) {
  const byMailbox = new Map<string, Set<string>>();
  for (const event of events) {
    const threads = byMailbox.get(event.mailboxId) ?? new Set();
    for (const threadId of event.threadIds) threads.add(threadId);
    byMailbox.set(event.mailboxId, threads);
  }
  return byMailbox;
}

function mergedThreads(events: Extract<MailEvent, { type: "threads.merged" }>[]) {
  const byMailbox = new Map<string, Set<string>>();
  for (const event of events) {
    const threads = byMailbox.get(event.mailboxId) ?? new Set();
    for (const threadId of [event.intoThreadId, ...event.fromThreadIds]) threads.add(threadId);
    byMailbox.set(event.mailboxId, threads);
  }
  return byMailbox;
}

/**
 * One AI job per thread that got a new message or lost one (its latest message may differ now);
 * flag changes need no AI. A job for a thread that is gone ends as `missing`.
 */
function aiJobsFor(events: MailEvent[], requestId: string): AiJob[] {
  const threads = new Map<string, AiJob>();
  const add = (event: { orgId: string; mailboxId: string }, threadId: string) =>
    threads.set(threadId, {
      kind: "thread",
      threadId,
      mailboxId: event.mailboxId,
      orgId: event.orgId,
      jobId: crypto.randomUUID(),
      requestId,
    });
  for (const event of events) {
    if (event.type === "message.created") add(event, event.threadId);
    if (event.type === "messages.pruned") for (const id of event.threadIds) add(event, id);
    // The survivor's summary was cleared; the job writes one for the whole conversation.
    if (event.type === "threads.merged") add(event, event.intoThreadId);
  }
  return [...threads.values()];
}
