import { DEFAULT_MAX_AGE_SECONDS, verifyRequest } from "@omni/crypto";
import {
  MAIL_EVENTS_PATH,
  MAX_EVENTS_PER_REQUEST,
  mailEventSchema,
  type MailEvent,
} from "@omni/contracts";
import {
  applyInboundMessage,
  newArrivals,
  recordCustomer,
  resolveDiscarded,
  type Db,
} from "@omni/db";
import { z } from "zod";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiFailure } from "../errors.ts";
import { openDb } from "../db.ts";
import { loadConfig, type Config } from "../env.ts";
import type { Logger } from "../log.ts";
import { modules } from "../modules.ts";
import { pingMailService } from "../mail-service.ts";
import type { AiJob } from "../queue.ts";
import { announceMerges, fanOut, notifyFailedActions, notifyMembers } from "../realtime.ts";

const QUEUE_BATCH_MAX = 100;

const envelope = z.object({
  events: z
    .array(z.looseObject({ type: z.string() }))
    .min(1)
    .max(MAX_EVENTS_PER_REQUEST),
});
const knownTypes = new Set<string>(mailEventSchema.options.map((o) => o.shape.type.value));

type EventOf<T extends MailEvent["type"]> = Extract<MailEvent, { type: T }>;
type Created = EventOf<"message.created">;

interface Delivery {
  c: Context<AppEnv>;
  db: Db;
  config: Config;
  log: Logger;
}

async function verifyMailService(c: Context<AppEnv>, config: Config, body: string) {
  const url = new URL(c.req.url);
  const verified = await verifyRequest({
    secret: config.MAIL_SERVICE_HMAC_SECRET,
    method: c.req.method,
    path: url.pathname + url.search,
    body,
    headers: c.req.raw.headers,
  });
  if (!verified.ok) throw new ApiFailure("unauthorized", verified.reason);
  if (!verified.nonce) throw new ApiFailure("unauthorized", "missing_nonce");
  const guard = c.env.REPLAY_GUARD.get(c.env.REPLAY_GUARD.idFromName("mail-service"));
  const expiresAt = (verified.timestamp + DEFAULT_MAX_AGE_SECONDS + 1) * 1000;
  if (!(await guard.claim(verified.nonce, expiresAt))) {
    throw new ApiFailure("unauthorized", "replayed");
  }
}

function parseEvents(body: string) {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ApiFailure("bad_request", "invalid json");
  }
  const parsed = envelope.safeParse(json);
  if (!parsed.success) {
    throw new ApiFailure("bad_request", "invalid body", {
      details: { issues: parsed.error.issues },
    });
  }
  const events: MailEvent[] = [];
  for (const raw of parsed.data.events) {
    if (!knownTypes.has(raw.type)) continue;
    const event = mailEventSchema.safeParse(raw);
    if (!event.success) {
      throw new ApiFailure("bad_request", "invalid event", {
        details: { issues: event.error.issues },
      });
    }
    events.push(event.data);
  }
  return events;
}

function ofType<T extends MailEvent["type"]>(events: MailEvent[], type: T) {
  return events.filter((e): e is EventOf<T> => e.type === type);
}

function addThreads(byMailbox: Map<string, Set<string>>, mailboxId: string, threadIds: string[]) {
  const threads = byMailbox.get(mailboxId) ?? new Set();
  for (const threadId of threadIds) threads.add(threadId);
  byMailbox.set(mailboxId, threads);
}

function threadsByMailbox(entries: [mailboxId: string, threadIds: string[]][]) {
  const byMailbox = new Map<string, Set<string>>();
  for (const [mailboxId, threadIds] of entries) addThreads(byMailbox, mailboxId, threadIds);
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

async function queueAiJobs(c: Context<AppEnv>, jobs: AiJob[]) {
  for (let i = 0; i < jobs.length; i += QUEUE_BATCH_MAX) {
    await c.env.AI_QUEUE.sendBatch(jobs.slice(i, i + QUEUE_BATCH_MAX).map((body) => ({ body })));
  }
}

function logFailures(log: Logger, failed: EventOf<"action.failed">[]) {
  for (const event of failed) {
    log.warn("action.failed", {
      actionId: event.actionId,
      orgId: event.orgId,
      mailboxId: event.mailboxId,
      actionRequestId: event.requestId ?? null,
    });
  }
}

function tellModulesMailArrived({ c, log }: Delivery, created: Created[]) {
  const messageIds = created.map((event) => event.messageId);
  const arrived = openDb(c.env);
  c.executionCtx.waitUntil(
    Promise.allSettled(
      modules.map((module) => module.mailArrived?.(c.env, arrived.db, messageIds, log)),
    )
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            log.warn("module.mail_arrived_failed", { error: result.reason });
          }
        }
      })
      .finally(() => arrived.close()),
  );
}

async function notifyInbound(
  { c, db }: Delivery,
  applied: Extract<Awaited<ReturnType<typeof applyInboundMessage>>, { applied: true }>,
) {
  const { orgId, id: threadId } = applied.conversation;
  await notifyMembers(c.env, db, {
    orgId,
    threadId,
    memberIds: applied.notified,
    kind: "customer_reply",
  });
  if (applied.autoAssigned) {
    await notifyMembers(c.env, db, {
      orgId,
      threadId,
      memberIds: [applied.autoAssigned],
      kind: "assigned",
    });
  }
}

async function applyCreated(delivery: Delivery, created: Created[]) {
  const { c, db, config, log } = delivery;
  for (const event of created) await recordCustomer(db, event);
  let queuedActions = 0;
  const fresh = new Set<string>();
  const landed: string[] = [];
  for (const event of created) {
    const applied = await applyInboundMessage(db, {
      messageId: event.messageId,
      folderRole: event.folderRole,
    });
    if (applied.applied || applied.fresh) {
      fresh.add(event.mailboxId);
      if (event.folderRole === "inbox") landed.push(event.messageId);
    }
    if (!applied.applied) continue;
    queuedActions += applied.queuedActions;
    await notifyInbound(delivery, applied);
  }
  if (queuedActions > 0) {
    c.executionCtx.waitUntil(pingMailService({ config, log, requestId: c.var.requestId }));
  }
  if (created.length) {
    const arrived = await newArrivals(db, landed);
    const changed = threadsByMailbox(created.map((e) => [e.mailboxId, [e.threadId]]));
    await fanOut(c.env, db, config, changed, { push: fresh, arrived });
  }
}

async function resolveDiscardedThreads(
  { c, db, config, log }: Delivery,
  discarded: EventOf<"threads.discarded">[],
) {
  const resolved = new Map<string, Set<string>>();
  for (const event of discarded) {
    for (const threadId of event.threadIds) {
      const result = await resolveDiscarded(db, { threadId });
      if (result.changed) addThreads(resolved, event.mailboxId, [threadId]);
    }
  }
  log.info("threads.discarded", {
    resolved: [...resolved.values()].reduce((n, t) => n + t.size, 0),
  });
  if (resolved.size) await fanOut(c.env, db, config, resolved);
}

async function deliver(delivery: Delivery, events: MailEvent[]) {
  const { c, db, config } = delivery;
  const created = ofType(events, "message.created");
  if (created.length) tellModulesMailArrived(delivery, created);
  await applyCreated(delivery, created);
  for (const listed of [ofType(events, "messages.pruned"), ofType(events, "threads.changed")]) {
    const threads = threadsByMailbox(listed.map((e) => [e.mailboxId, e.threadIds]));
    if (listed.length) await fanOut(c.env, db, config, threads);
  }
  const merged = ofType(events, "threads.merged");
  if (merged.length) {
    const threads = merged.map(
      (e) => [e.mailboxId, [e.intoThreadId, ...e.fromThreadIds]] satisfies [string, string[]],
    );
    await fanOut(c.env, db, config, threadsByMailbox(threads));
    await announceMerges(c.env, db, merged);
  }
  const discarded = ofType(events, "threads.discarded");
  if (discarded.length) await resolveDiscardedThreads(delivery, discarded);
  await notifyFailedActions(c.env, ofType(events, "action.failed"));
}

export const internal = new Hono<AppEnv>().post(MAIL_EVENTS_PATH, async (c) => {
  const config = loadConfig(c.env);
  const body = await c.req.text();
  await verifyMailService(c, config, body);
  const events = parseEvents(body);

  const log = c.var.log.child({ component: "internal" });
  const jobs = aiJobsFor(events, c.var.requestId);
  log.info("mail_events.received", { events: events.length, jobs: jobs.length });
  logFailures(log, ofType(events, "action.failed"));
  await queueAiJobs(c, jobs);

  const { db, close } = openDb(c.env);
  try {
    await deliver({ c, db, config, log }, events);
  } finally {
    c.executionCtx.waitUntil(close());
  }
  return c.json({ ok: true, jobs: jobs.length }, 202);
});
