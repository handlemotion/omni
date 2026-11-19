import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { RATE_LIMIT_AUTH: "off" },
  });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

const fileIn = (threadId: string, lane: string, cookie: string, key = `key-${randomUUID()}`) =>
  fetch(new URL(`/api/threads/${threadId}/lane`, worker.url), {
    method: "PUT",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ lane }),
  });

async function laneList(lane: string, cookie: string) {
  const response = await fetch(new URL(`/api/threads?lane=${lane}`, worker.url), {
    headers: { cookie },
  });
  const body = (await response.json()) as { threads: { id: string }[] };
  return body.threads.map((t) => t.id);
}

async function stored(threadId: string) {
  const [row] = await database.db
    .select({ triage: schema.threads.triage, source: schema.threads.triageSource })
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  return row;
}

async function desk(tag = "lane") {
  const { db } = database;
  const org = await createOrg(db, tag);
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM).catch(() => undefined);
  const own = await createMailbox(db, org.id, `ana@${tag}.test`, "personal");
  const shared = await createMailbox(db, org.id, `support@${tag}.test`);
  const ana = await createMember(db, org.id, `ana@${tag}.test`);
  await createMember(db, org.id, `carl@${tag}.test`);
  await grant(db, org.id, own.id, ana.id);
  await grant(db, org.id, shared.id, ana.id);
  const seed = (mailbox: typeof own, uid: number) =>
    seedMessage(db, mailbox, { subject: `Lane ${uid}`, fromAddress: "pat@client.test", uid });
  return {
    personal: (await seed(own, 1)).threadId,
    shared: (await seed(shared, 2)).threadId,
    ana: await signIn(worker, db, `ana@${tag}.test`),
    carl: await signIn(worker, db, `carl@${tag}.test`),
  };
}

test("a member files a thread in a lane on a personal and a shared mailbox, and no one else can", async () => {
  const { personal, shared, ana, carl } = await desk();

  for (const threadId of [personal, shared]) {
    const filed = await fileIn(threadId, "waiting_on_them", ana);
    expect(filed.status).toBe(200);
    expect(await filed.json()).toEqual({ triage: "waiting_on_them", changed: true });
    expect(await stored(threadId)).toEqual({ triage: "waiting_on_them", source: "person" });
  }
  expect((await laneList("waiting_on_them", ana)).toSorted()).toEqual(
    [personal, shared].toSorted(),
  );

  const again = await fileIn(shared, "waiting_on_them", ana);
  expect(await again.json()).toEqual({ triage: "waiting_on_them", changed: false });

  expect((await fileIn(shared, "unsure", ana)).status).toBe(400);

  const outsider = await fileIn(shared, "noise", carl);
  expect(outsider.status).toBe(404);
  expect((await fileIn(personal, "noise", carl)).status).toBe(404);
  expect(await stored(shared)).toEqual({ triage: "waiting_on_them", source: "person" });
  expect(await stored(personal)).toEqual({ triage: "waiting_on_them", source: "person" });
});

test("a retried re-sort cannot undo a teammate's re-sort made in between", async () => {
  const { shared, ana } = await desk("retry");
  const key = `key-${randomUUID()}`;

  expect(await (await fileIn(shared, "needs_reply", ana, key)).json()).toEqual({
    triage: "needs_reply",
    changed: true,
  });
  expect((await fileIn(shared, "noise", ana)).status).toBe(200);

  const retry = await fileIn(shared, "needs_reply", ana, key);
  expect(await retry.json()).toEqual({ triage: "needs_reply", changed: false });
  expect(await stored(shared)).toEqual({ triage: "noise", source: "person" });
});
