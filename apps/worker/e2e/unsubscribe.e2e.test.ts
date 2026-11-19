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

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
}

async function newsletter(slug: string, uris: string[], oneClick = false) {
  const { db } = database;
  const org = await createOrg(db, slug);
  const inbox = await createMailbox(db, org.id, `ana@${slug}.test`);
  const ana = await createMember(db, org.id, `ana@${slug}.test`);
  await grant(db, org.id, inbox.id, ana.id);
  const { threadId, messageId } = await seedMessage(db, inbox, {
    subject: "This week's news",
    fromAddress: "news@lists.example.com",
    uid: 1,
    sentAt: new Date(Date.now() - 60_000),
  });
  await db
    .update(schema.messages)
    .set({ listUnsubscribe: uris, listUnsubscribeOneClick: oneClick })
    .where(eq(schema.messages.id, messageId));
  return { inbox, threadId, messageId, cookie: await signIn(worker, db, `ana@${slug}.test`) };
}

async function shown(threadId: string, cookie: string) {
  const thread = (await (await api(`/threads/${threadId}`, cookie)).json()) as {
    messages: { unsubscribe: unknown }[];
  };
  return thread.messages[0]?.unsubscribe;
}

function unsubscribe(threadId: string, messageId: string, cookie: string, key: string) {
  return api(`/threads/${threadId}/unsubscribe`, cookie, {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ messageId }),
  });
}

test("a mailto list is mailed once from the inbox, with the subject it names", async () => {
  const { inbox, threadId, messageId, cookie } = await newsletter("unsub-mail", [
    "mailto:leave-ab12@lists.example.com?subject=remove%20me",
    "https://lists.example.com/u/ab12",
  ]);
  expect(await shown(threadId, cookie)).toEqual({ kind: "mail", url: null, unsubscribed: false });

  const first = await unsubscribe(threadId, messageId, cookie, "unsubscribe-1");
  expect(first.status).toBe(202);
  const again = await unsubscribe(threadId, messageId, cookie, "unsubscribe-1");
  const [a, b] = (await Promise.all([first.json(), again.json()])) as { actionId: string }[];
  expect(b!.actionId).toBe(a!.actionId);

  const sends = await database.db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.mailboxId, inbox.id));
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    kind: "send",
    payload: {
      from: "ana@unsub-mail.test",
      to: ["leave-ab12@lists.example.com"],
      subject: "remove me",
    },
  });
  const [left] = await database.db
    .select()
    .from(schema.listUnsubscribes)
    .where(eq(schema.listUnsubscribes.mailboxId, inbox.id));
  expect(left?.unsubscribedAt.getTime()).toBe(sends[0]!.createdAt.getTime());
});

test("a page-only list is opened by the app, and a one-click URL on a private address is refused", async () => {
  const page = await newsletter("unsub-page", ["https://lists.example.com/u/cd34"]);
  expect(await shown(page.threadId, page.cookie)).toEqual({
    kind: "link",
    url: "https://lists.example.com/u/cd34",
    unsubscribed: false,
  });
  const refused = await unsubscribe(page.threadId, page.messageId, page.cookie, "unsubscribe-2");
  expect(refused.status).toBe(422);

  const dead = await newsletter("unsub-dead", ["https://127.0.0.1/u"], true);
  expect(await shown(dead.threadId, dead.cookie)).toEqual({
    kind: "post",
    url: null,
    unsubscribed: false,
  });
  const failed = await unsubscribe(dead.threadId, dead.messageId, dead.cookie, "unsubscribe-3");
  expect(failed.status).toBe(502);
  expect(await shown(dead.threadId, dead.cookie)).toMatchObject({ unsubscribed: false });
});

test("leaving a list sticks across reads, and the list's next issue offers it again", async () => {
  const { inbox, threadId, messageId, cookie } = await newsletter("unsub-stick", [
    "mailto:leave-ef56@lists.example.com",
  ]);
  const left = await unsubscribe(threadId, messageId, cookie, "unsubscribe-4");
  expect(left.status).toBe(202);
  expect(await shown(threadId, cookie)).toMatchObject({ unsubscribed: true });

  const later = await seedMessage(database.db, inbox, {
    subject: "Next week's news",
    fromAddress: "News@Lists.Example.com",
    uid: 2,
    sentAt: new Date(Date.now() + 60_000),
  });
  await database.db
    .update(schema.messages)
    .set({ listUnsubscribe: ["mailto:leave-gh78@lists.example.com"] })
    .where(eq(schema.messages.id, later.messageId));
  expect(await shown(threadId, cookie)).toMatchObject({ unsubscribed: true });
  expect(await shown(later.threadId, cookie)).toMatchObject({ unsubscribed: false });
});
