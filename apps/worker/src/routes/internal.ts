import { DEFAULT_MAX_AGE_SECONDS, verifyRequest } from "@omni/crypto";
import {
  MAIL_EVENTS_PATH,
  MAX_EVENTS_PER_REQUEST,
  mailEventSchema,
  type MailEvent,
} from "@omni/contracts";
import { applyInboundMessage, newArrivals, recordCustomer, resolveDiscarded } from "@omni/db";
import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
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
  if (!verified.ok) return apiError(c, "unauthorized", verified.reason);
  if (!verified.nonce) return apiError(c, "unauthorized", "missing_nonce");

  const guard = c.env.REPLAY_GUARD.get(c.env.REPLAY_GUARD.idFromName("mail-service"));
  const expiresAt = (verified.timestamp + DEFAULT_MAX_AGE_SECONDS + 1) * 1000;
  if (!(await guard.claim(verified.nonce, expiresAt))) {
    return apiError(c, "unauthorized", "replayed");
  }

  let parsed;
  try {
    parsed = envelope.safeParse(JSON.parse(body));
  } catch {
    return apiError(c, "bad_request", "invalid json");
  }
  if (!parsed.success) {
    return apiError(c, "bad_request", "invalid body", { details: { issues: parsed.error.issues } });
  }
  const events: MailEvent[] = [];
  for (const raw of parsed.data.events) {
    if (!knownTypes.has(raw.type)) continue;
    const event = mailEventSchema.safeParse(raw);
    if (!event.success) {
      return apiError(c, "bad_request", "invalid event", {
        details: { issues: event.error.issues },
      });
    }
    events.push(event.data);
  }

  const log = c.var.log.child({ component: "internal" });
  const jobs = aiJobsFor(events, c.var.requestId);
  const failed = events.filter((e) => e.type === "action.failed");
  log.info("mail_events.received", { events: events.length, jobs: jobs.length });
  for (const event of failed) {
    log.warn("action.failed", {
      actionId: event.actionId,
      orgId: event.orgId,
      mailboxId: event.mailboxId,
      actionRequestId: event.requestId ?? null,
    });
  }
  for (let i = 0; i < jobs.length; i += QUEUE_BATCH_MAX) {
    await c.env.AI_QUEUE.sendBatch(jobs.slice(i, i + QUEUE_BATCH_MAX).map((body) => ({ body })));
  }

  const { db, close } = openDb(c.env);
  try {
    const created = events.filter((e) => e.type === "message.created");
    for (const event of created) await recordCustomer(db, event);
    let queuedActions = 0;
    const fresh = new Set<string>();
    const landed: string[] = [];
    for (const event of created) {
      const applied = await applyInboundMessage(db, {
        messageId: event.messageId,
        folderRole: event.folderRole,
      });
      if (applied.applied || applied.fresh) fresh.add(event.mailboxId);
      if ((applied.applied || applied.fresh) && event.folderRole === "inbox") {
        landed.push(event.messageId);
      }
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
    if (created.length) {
      const arrived = await newArrivals(db, landed);
      await fanOut(c.env, db, config, changedThreads(created), { push: fresh, arrived });
    }
    const pruned = events.filter((e) => e.type === "messages.pruned");
    if (pruned.length) await fanOut(c.env, db, config, listedThreads(pruned));
    const changed = events.filter((e) => e.type === "threads.changed");
    if (changed.length) await fanOut(c.env, db, config, listedThreads(changed));
    const merged = events.filter((e) => e.type === "threads.merged");
    if (merged.length) {
      await fanOut(c.env, db, config, mergedThreads(merged));
      await announceMerges(c.env, db, merged);
    }
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

function listedThreads(
  events: Extract<MailEvent, { type: "messages.pruned" | "threads.changed" }>[],
) {
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

function aiJobsFor(events: MailEvent[], requestId: string) {
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
    if (event.type === "threads.merged") add(event, event.intoThreadId);
  }
  return [...threads.values()] satisfies AiJob[];
}
