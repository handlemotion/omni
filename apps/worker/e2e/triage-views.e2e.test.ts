// Inbox, Later, Done and All mail over the real API: per-member state on a shared mailbox, the
// done watermark, and Later, which holds a thread until the member moves it back (ADR 0007, ADR 0027).
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
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

let keys = 0;

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": `triage-views-${keys++}`,
      ...init.headers,
    },
  });
}

type Row = { id: string; done: boolean; later: boolean };

async function view(cookie: string, name: string) {
  const response = await api(`/threads?view=${name}`, cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { threads: Row[] }).threads.map((t) => t.id);
}

async function counts(cookie: string) {
  const body = (await (await api("/counts", cookie)).json()) as {
    counts: { inbox: number; later: number }[];
  };
  return body.counts.map(({ inbox, later }) => ({ inbox, later }));
}

async function action(cookie: string, method: string, path: string, json?: unknown) {
  const response = await api(path, cookie, {
    method,
    ...(json ? { body: JSON.stringify(json) } : {}),
  });
  return { status: response.status, body: (await response.json()) as { state: Row } };
}

/** A shared hello@ seen by Ana and Bea, with one thread from a customer. */
async function sharedInbox(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const box = await createMailbox(db, org.id, `hello@${slug}.test`, "shared");
  const ana = await createMember(db, org.id, `ana@${slug}.test`);
  const bea = await createMember(db, org.id, `bea@${slug}.test`);
  await grant(db, org.id, box.id, ana.id);
  await grant(db, org.id, box.id, bea.id);
  const sentAt = new Date("2026-11-01T09:00:00Z");
  const seeded = await seedMessage(db, box, {
    subject: "Quote",
    fromAddress: "luis@client.test",
    uid: 1,
    sentAt,
  });
  return {
    box,
    sentAt,
    threadId: seeded.threadId,
    ana: await signIn(worker, db, `ana@${slug}.test`),
    bea: await signIn(worker, db, `bea@${slug}.test`),
    anaId: ana.id,
  };
}

test("Later takes a thread out of that member's Inbox with no time attached, until they move it back", async () => {
  const { threadId, ana, bea } = await sharedInbox("later");
  expect(await view(ana, "inbox")).toEqual([threadId]);

  const moved = await action(ana, "POST", `/threads/${threadId}/later`);
  expect(moved).toMatchObject({ status: 200, body: { state: { done: false, later: true } } });
  // Tabs open from before Later read `deferredUntil` and must see the thread as deferred.
  const row = (await (await api("/threads?view=later", ana)).json()) as {
    threads: { deferredUntil: string | null }[];
  };
  expect(row.threads[0]?.deferredUntil).toBe("9999-12-31T00:00:00.000Z");
  expect(await view(ana, "inbox")).toEqual([]);
  expect(await view(ana, "later")).toEqual([threadId]);
  // A tab open from before the rename still asks for `queue`, and gets Later.
  expect(await view(ana, "queue")).toEqual([threadId]);
  expect(await counts(ana)).toEqual([{ inbox: 0, later: 1 }]);
  // Bea shares the mailbox, not Ana's Later.
  expect(await view(bea, "inbox")).toEqual([threadId]);
  expect(await view(bea, "later")).toEqual([]);

  const back = await action(ana, "DELETE", `/threads/${threadId}/later`);
  expect(back).toMatchObject({ status: 200, body: { state: { later: false } } });
  expect(await view(ana, "inbox")).toEqual([threadId]);
  expect(await view(ana, "later")).toEqual([]);
  expect(await counts(ana)).toEqual([{ inbox: 1, later: 0 }]);
});

test("done leaves Inbox and Later but stays in All mail, for the member who marked it only", async () => {
  const { threadId, sentAt, ana, bea, anaId } = await sharedInbox("done");
  await action(ana, "POST", `/threads/${threadId}/later`);
  expect(await view(ana, "later")).toEqual([threadId]);

  const done = await action(ana, "POST", `/threads/${threadId}/done`, {
    through: sentAt.toISOString(),
  });
  expect(done).toMatchObject({
    status: 200,
    body: { state: { done: true, later: false } },
  });
  expect(await view(ana, "inbox")).toEqual([]);
  expect(await view(ana, "later")).toEqual([]);
  expect(await view(ana, "done")).toEqual([threadId]);
  expect(await view(ana, "all")).toEqual([threadId]);
  expect(await counts(ana)).toEqual([{ inbox: 0, later: 0 }]);

  // Bea's view of the same shared thread is untouched, and nothing went to the outbox: done is
  // not an IMAP move.
  expect(await view(bea, "inbox")).toEqual([threadId]);
  expect(await view(bea, "done")).toEqual([]);
  const outbox = await database.db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.memberId, anaId));
  expect(outbox).toEqual([]);
  const [thread] = await database.db
    .select({ archived: schema.threads.archived })
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  expect(thread?.archived).toBe(false);

  // Undone: back in the Inbox, out of Done.
  const undone = await action(ana, "DELETE", `/threads/${threadId}/done`);
  expect(undone).toMatchObject({ status: 200, body: { state: { done: false } } });
  expect(await view(ana, "inbox")).toEqual([threadId]);
  expect(await view(ana, "done")).toEqual([]);
});

test("a new message on a done thread brings it back; done on a stale view does not hide it", async () => {
  const { box, threadId, sentAt, ana } = await sharedInbox("reopen");
  await action(ana, "POST", `/threads/${threadId}/done`, { through: sentAt.toISOString() });
  expect(await view(ana, "inbox")).toEqual([]);

  // A reply lands through the same writer the mail service uses.
  const replyAt = new Date(sentAt.getTime() + 60_000);
  await seedMessage(database.db, box, {
    subject: "Re: Quote",
    fromAddress: "luis@client.test",
    uid: 2,
    threadId,
    sentAt: replyAt,
  });
  expect(await view(ana, "inbox")).toEqual([threadId]);
  expect(await view(ana, "done")).toEqual([]);

  // Marking done from a screen that still shows the first message leaves the reply unattended.
  const stale = await action(ana, "POST", `/threads/${threadId}/done`, {
    through: sentAt.toISOString(),
  });
  expect(stale).toMatchObject({ status: 200, body: { state: { done: false } } });
  expect(await view(ana, "inbox")).toEqual([threadId]);

  // A retry of the same request writes the same row.
  const current = { through: replyAt.toISOString() };
  const first = await action(ana, "POST", `/threads/${threadId}/done`, current);
  const retried = await action(ana, "POST", `/threads/${threadId}/done`, current);
  expect(first.body).toEqual(retried.body);
  expect(first.body.state.done).toBe(true);
  expect(await view(ana, "inbox")).toEqual([]);
});

test("triage actions need an idempotency key and a thread the member can see", async () => {
  const { threadId, sentAt } = await sharedInbox("guard");
  const { db } = database;
  const org = await createOrg(db, "outsider");
  const eve = await createMember(db, org.id, "eve@outsider.test");
  await createMailbox(db, org.id, "eve@outsider.test", "personal").then((box) =>
    grant(db, org.id, box.id, eve.id),
  );
  const outsider = await signIn(worker, db, "eve@outsider.test");

  for (const [method, path, json] of [
    ["POST", `/threads/${threadId}/done`, { through: sentAt.toISOString() }],
    ["DELETE", `/threads/${threadId}/done`, undefined],
    ["POST", `/threads/${threadId}/later`, undefined],
    ["DELETE", `/threads/${threadId}/later`, undefined],
  ] as const) {
    expect((await action(outsider, method, path, json)).status).toBe(404);
    const unkeyed = await fetch(new URL(`/api${path}`, worker.url), {
      method,
      headers: { cookie: outsider, "content-type": "application/json" },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
    expect(unkeyed.status).toBe(400);
    // The API's one error shape, with a message the app can show (not a raw Zod error object).
    expect(await unkeyed.json()).toEqual({
      error: expect.stringContaining("idempotency-key"),
      requestId: unkeyed.headers.get("x-request-id"),
    });
  }
  expect(await view(outsider, "all")).toEqual([]);
  expect(
    await db.select().from(schema.threadState).where(eq(schema.threadState.threadId, threadId)),
  ).toEqual([]);
});
