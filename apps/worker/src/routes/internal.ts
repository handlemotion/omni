// Calls from the mail service. Each is HMAC-signed with a timestamp and a nonce; the nonce is
// claimed in the ReplayGuard Durable Object, so a request is accepted once at most.
import { DEFAULT_MAX_AGE_SECONDS, verifyRequest } from "@omni/crypto";
import { MAIL_EVENTS_PATH, mailEventsBodySchema, type MailEvent } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { loadConfig } from "../env.ts";
import type { AiJob } from "../queue.ts";

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
    parsed = mailEventsBodySchema.safeParse(JSON.parse(body));
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);

  const jobs = aiJobsFor(parsed.data.events);
  if (jobs.length) await c.env.AI_QUEUE.sendBatch(jobs.map((body) => ({ body })));
  return c.json({ ok: true, jobs: jobs.length }, 202);
});

/** One AI job per thread that got a new message; flag changes need no AI. */
function aiJobsFor(events: MailEvent[]): AiJob[] {
  const threads = new Map<string, AiJob>();
  for (const event of events) {
    if (event.kind !== "message.created") continue;
    threads.set(event.threadId, { kind: "thread", threadId: event.threadId });
  }
  return [...threads.values()];
}
