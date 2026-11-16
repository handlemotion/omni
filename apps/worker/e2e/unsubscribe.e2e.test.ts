// Leaving a mailing list over the real Worker and Postgres: a mailto list gets its message through
// the outbox, a page-only list is left to the app, and a list that does not answer is a failure.
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

/** A newsletter in Ana's inbox carrying `uris` as its List-Unsubscribe. */
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
  expect(await shown(threadId, cookie)).toEqual({ kind: "mail", url: null });

  const first = await unsubscribe(threadId, messageId, cookie, "unsubscribe-1");
  expect(first.status).toBe(202);
  // A retried press answers the same send instead of mailing the list again.
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
});

test("a page-only list is opened by the app, and a one-click URL on a private address is refused", async () => {
  const page = await newsletter("unsub-page", ["https://lists.example.com/u/cd34"]);
  expect(await shown(page.threadId, page.cookie)).toEqual({
    kind: "link",
    url: "https://lists.example.com/u/cd34",
  });
  const refused = await unsubscribe(page.threadId, page.messageId, page.cookie, "unsubscribe-2");
  expect(refused.status).toBe(422);

  // Mail chooses the URL: the Worker never posts to a private address (SSRF), and the reader
  // is not told they left.
  const dead = await newsletter("unsub-dead", ["https://127.0.0.1/u"], true);
  expect(await shown(dead.threadId, dead.cookie)).toEqual({ kind: "post", url: null });
  const failed = await unsubscribe(dead.threadId, dead.messageId, dead.cookie, "unsubscribe-3");
  expect(failed.status).toBe(502);
});
