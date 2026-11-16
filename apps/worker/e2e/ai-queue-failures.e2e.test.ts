// How the AI queue consumer settles a job that fails (ADR 0038 decision 2). A permanent failure
// (a malformed job, a request TypeSafe refuses) is dead-lettered on its first attempt; a
// retryable one (TypeSafe overloaded) is retried in the same invocation, then handed back to
// Queues, and is not dead-lettered. Real Worker (workerd) and its real local queue, real
// Postgres, and a real HTTP endpoint where TypeSafe listens.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  seedMessage,
  startMailServiceEndpoint,
  startWorker,
  waitForEvents,
  workerEvents,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let typesafe: Awaited<ReturnType<typeof startTypesafe>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

/** Answers every request with `status`; counts what it was asked. */
async function startTypesafe() {
  const state = { status: 503, requests: 0 };
  const server: Server = createServer(async (req, res) => {
    for await (const _ of req);
    state.requests++;
    res.writeHead(state.status, { "content-type": "application/json" }).end('{"error":"e2e"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  typesafe = await startTypesafe();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { TYPESAFE_API_URL: typesafe.url },
    secrets: { TYPESAFE_API_KEY: "e2e" },
  });
});

afterAll(async () => {
  await worker?.server.close();
  await typesafe?.close();
  await mailService?.close();
  await database?.teardown();
});

/** A personal inbox with one customer email, which only a model call can triage. */
async function threadToTriage(slug: string) {
  const org = await createOrg(database.db, slug);
  const box = await createMailbox(database.db, org.id, `me@${slug}.test`, "personal");
  const { threadId } = await seedMessage(database.db, box, {
    subject: "Quote for March",
    fromAddress: "luis@client.test",
    text: "Could you send the quote for the March order by Friday?",
    uid: 1,
  });
  return { orgId: org.id, mailboxId: box.id, threadId };
}

async function enqueue(job: Record<string, unknown>) {
  const env = await worker.server
    .getWorker<{ AI_QUEUE: { send(body: unknown): Promise<void> } }>()
    .getEnv();
  await env.AI_QUEUE.send({ kind: "thread", ...job });
}

const deadLetter = async (jobId: string) =>
  (
    await database.db.select().from(schema.deadLetters).where(eq(schema.deadLetters.jobId, jobId))
  )[0];

test("a job no retry can fix is dead-lettered on its first attempt, not retried for 15 minutes", async () => {
  // TypeSafe refuses the request itself.
  typesafe.state.status = 400;
  typesafe.state.requests = 0;
  const refused = { ...(await threadToTriage("refused")), jobId: randomUUID() };
  await enqueue(refused);
  // A job with no thread to triage.
  const malformed = { ...(await threadToTriage("malformed")), jobId: randomUUID() };
  await enqueue({ ...malformed, threadId: undefined });

  for (const job of [refused, malformed]) {
    const [dead] = await waitForEvents(
      worker,
      (e) => e.event === "ai.job_dead" && e.jobId === job.jobId,
    );
    expect(dead).toMatchObject({ attempts: 1, permanent: true, orgId: job.orgId });
    await expect
      .poll(() => deadLetter(job.jobId))
      .toMatchObject({
        orgId: job.orgId,
        queue: "omni-ai",
        attempts: 1,
      });
  }
  expect((await deadLetter(refused.jobId))?.error).toContain("TypeSafe returned 400");
  // Asked once: a refusal is not retried in the invocation either.
  expect(typesafe.state.requests).toBe(1);
  expect(
    workerEvents(worker).filter(
      (e) =>
        e.event === "ai.job_failed" && (e.jobId === refused.jobId || e.jobId === malformed.jobId),
    ),
  ).toEqual([]);
});

test("a job that may pass later is retried in the invocation, then by Queues, and not dead-lettered", async () => {
  // TypeSafe is overloaded.
  typesafe.state.status = 503;
  typesafe.state.requests = 0;
  const job = { ...(await threadToTriage("overloaded")), jobId: randomUUID() };
  await enqueue(job);

  const [failed] = await waitForEvents(
    worker,
    (e) => e.event === "ai.job_failed" && e.jobId === job.jobId,
  );
  expect(failed).toMatchObject({ attempts: 1, permanent: false, step: "triage" });
  // The first try and two in-invocation retries; the next attempt is Queues' (30 s later).
  expect(typesafe.state.requests).toBe(3);
  expect(await deadLetter(job.jobId)).toBeUndefined();
  expect(
    workerEvents(worker).filter((e) => e.event === "ai.job_dead" && e.jobId === job.jobId),
  ).toEqual([]);
  // The thread is untouched: no triage was saved, so the next attempt triages it.
  const [thread] = await database.db
    .select({ triage: schema.threads.triage })
    .from(schema.threads)
    .where(eq(schema.threads.id, job.threadId));
  expect(thread?.triage).toBeNull();
});
