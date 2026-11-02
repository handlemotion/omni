// Calls from the mail service. Each is HMAC-signed with a timestamp and a nonce; the nonce is
// claimed in the ReplayGuard Durable Object, so a request is accepted once at most.
import { DEFAULT_MAX_AGE_SECONDS, verifyRequest } from "@omni/crypto";
import {
  MAIL_EVENTS_PATH,
  MAX_EVENTS_PER_REQUEST,
  mailEventSchema,
  type MailEvent,
} from "@omni/contracts";
import { createDb } from "@omni/db";
import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { loadConfig } from "../env.ts";
import type { AiJob } from "../queue.ts";
import { fanOut, notifyFailedActions } from "../realtime.ts";

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

  const jobs = aiJobsFor(events);
  if (jobs.length) await c.env.AI_QUEUE.sendBatch(jobs.map((body) => ({ body })));

  const { db, close } = createDb(c.env.HYPERDRIVE.connectionString, {
    max: 2,
    fetch_types: false,
    onnotice: () => {},
  });
  try {
    const created = events.filter((e) => e.type === "message.created");
    if (created.length) await fanOut(c.env, db, config, changedThreads(created), { push: true });
    await notifyFailedActions(
      c.env,
      events.filter((e) => e.type === "action.failed"),
    );
  } finally {
    c.executionCtx.waitUntil(close());
  }
  return c.json({ ok: true, jobs: jobs.length }, 202);
});

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

/** One AI job per thread that got a new message; flag changes need no AI. */
function aiJobsFor(events: MailEvent[]): AiJob[] {
  const threads = new Map<string, AiJob>();
  for (const event of events) {
    if (event.type !== "message.created") continue;
    threads.set(event.threadId, {
      kind: "thread",
      threadId: event.threadId,
      mailboxId: event.mailboxId,
    });
  }
  return [...threads.values()];
}
