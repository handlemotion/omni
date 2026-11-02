// The Worker and the real mail service together, the way production runs them: the Worker pings
// the mail service after an outbox write, the mail service sends through GreenMail, files and
// indexes the Sent copy, and reports back to the Worker over signed HTTP. Nothing is stood in.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseKeyring } from "@omni/crypto";
import { schema } from "@omni/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sealCredentials } from "../../mail/src/credentials.ts";
import type { MailboxConfig } from "../../mail/src/mailbox-connection.ts";
import { startService, type MailService } from "../../mail/src/service.ts";
import {
  deliver,
  logger,
  mailbox,
  otherClient,
  waitFor,
} from "../../mail/e2e/support/greenmail.ts";
import { createTestBucket } from "../../mail/e2e/support/objects.ts";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  HMAC_SECRET,
  openRealtime,
  postMailEvents,
  signIn,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let service: MailService | undefined;
let http: ReturnType<typeof createServer>;

beforeAll(async () => {
  database = await createTestDatabase();
  // The Worker needs the mail service's URL and the mail service the Worker's: listen first,
  // hand requests to the service once it exists.
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const response = service
      ? await service.app.fetch(
          new Request(`http://127.0.0.1${req.url ?? "/"}`, {
            method: req.method,
            headers,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          }),
        )
      : new Response(null, { status: 503 });
    res.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const mailServiceUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl });

  const bucket = await createTestBucket();
  service = await startService(
    {
      DATABASE_URL: database.url,
      MAIL_CREDENTIALS_KEY: keyring,
      MAIL_SERVICE_HMAC_SECRET: HMAC_SECRET,
      WORKER_URL: String(worker.url),
      S3_ENDPOINT: bucket.options.endpoint,
      S3_BUCKET: bucket.options.bucket,
      S3_ACCESS_KEY_ID: bucket.options.accessKeyId,
      S3_SECRET_ACCESS_KEY: bucket.options.secretAccessKey,
      S3_REGION: bucket.options.region,
      IMAGE_PROXY_URL: "/api/image-proxy",
      ATTACHMENT_URL: "/api/attachments",
      // Only IDLE and the Worker's pings drive work during a test.
      SYNC_INTERVAL_MS: 60 * 60_000,
      OUTBOX_INTERVAL_MS: 60 * 60_000,
      MAILBOX_CONCURRENCY: 4,
    },
    logger,
  );
  // Magic links go out from here; its credentials are unreadable, so they fail without a member.
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
});

afterAll(async () => {
  await service?.stop();
  await new Promise((resolve) => http?.close(resolve));
  await worker?.server.close();
  await database?.teardown();
});

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
}

/** A GreenMail mailbox the mail service can open, granted to `memberIds`. */
async function connectableMailbox(orgId: string, box: MailboxConfig, memberIds: string[]) {
  const { db } = database;
  const credentialsEnc = await sealCredentials(keyring, box.id, {
    user: box.user,
    pass: box.pass,
    imap: box.imap,
    smtp: box.smtp,
  });
  await db.insert(schema.mailboxes).values({
    id: box.id,
    orgId,
    address: box.address,
    kind: box.kind,
    credentialsEnc,
  });
  for (const memberId of memberIds) await grant(db, orgId, box.id, memberId);
  await service?.reconcileMailboxes();
  await waitFor(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, box.id));
    return row?.status === "active";
  });
}

const messagesOf = (mailboxId: string) =>
  database.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.mailboxId, mailboxId))
    .orderBy(asc(schema.messages.sentAt));

const actionStatus = async (id: string) =>
  (
    await database.db
      .select({ status: schema.mailActions.status })
      .from(schema.mailActions)
      .where(eq(schema.mailActions.id, id))
  )[0]?.status;

type AppMessage = {
  messageIdHeader: string;
  fromMe: boolean;
  display: "bubble" | "card";
  hasHtml: boolean;
  addedParticipants: { name: string | null; address: string }[];
};

test("a reply returns the Message-ID the mail service sends, and the real thread reads in chat mode", async () => {
  const { db } = database;
  const org = await createOrg(db, "roundtrip");
  const ana = await createMember(db, org.id, "ana@roundtrip.test");
  const box = mailbox("personal");
  const [luis, marta, bea] = [mailbox(), mailbox(), mailbox()];
  await connectableMailbox(org.id, box, [ana.id]);

  // Luis writes in HTML, copying Marta; then follows up and brings Bea in.
  await deliver(box.address, "Venue", {
    from: luis.address,
    cc: [marta.address],
    text: "Can you confirm the venue?",
    html: "<p>Can you <b>confirm</b> the venue?</p>",
  });
  const first = await waitFor(async () => {
    const rows = await messagesOf(box.id);
    return rows.length === 1 && rows[0];
  });
  await deliver(box.address, "Re: Venue", {
    from: luis.address,
    cc: [marta.address, bea.address],
    inReplyTo: first.messageIdHeader,
    text: "Adding Bea, who books it.",
  });
  await waitFor(async () => (await messagesOf(box.id)).length === 2);

  const cookie = await signIn(worker, db, "ana@roundtrip.test");
  const reply = await api(`/threads/${first.threadId}/reply`, cookie, {
    method: "POST",
    headers: { "idempotency-key": `venue-reply-${box.id}` },
    body: JSON.stringify({ text: "Confirmed. ".repeat(130), replyAll: true }),
  });
  expect(reply.status).toBe(202);
  const { actionId, messageIdHeader } = (await reply.json()) as {
    actionId: string;
    messageIdHeader: string;
  };
  await waitFor(async () => (await actionStatus(actionId)) === "done", 15_000);

  // What Luis received carries exactly the Message-ID the Worker returned: if the Worker and the
  // mail service derived it differently, the app's pending bubble would never be replaced.
  const inLuisInbox = await otherClient(luis, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await client.search({ header: { "message-id": messageIdHeader } }, { uid: true });
    } finally {
      lock.release();
    }
  });
  expect(inLuisInbox).toHaveLength(1);

  const thread = (await (await api(`/threads/${first.threadId}`, cookie)).json()) as {
    messages: (AppMessage & Record<string, unknown>)[];
  };
  // The Sent copy joined the thread under the same Message-ID.
  expect(thread.messages.map((m) => m.messageIdHeader)).toEqual([
    first.messageIdHeader,
    expect.any(String),
    messageIdHeader,
  ]);
  // Catches our own mail drawn as theirs, Bea's arrival missed or repeated, long replies as
  // bubbles, and HTML lost or claimed for text-only mail.
  expect(
    thread.messages.map(({ fromMe, display, hasHtml, addedParticipants }) => ({
      fromMe,
      display,
      hasHtml,
      addedParticipants,
    })),
  ).toEqual([
    { fromMe: false, display: "bubble", hasHtml: true, addedParticipants: [] },
    {
      fromMe: false,
      display: "bubble",
      hasHtml: false,
      addedParticipants: [{ name: null, address: bea.address }],
    },
    { fromMe: true, display: "card", hasHtml: false, addedParticipants: [] },
  ]);
  // Storage keys stay on the server.
  for (const message of thread.messages) {
    expect(message).not.toHaveProperty("r2Key");
    expect(message).not.toHaveProperty("htmlR2Key");
  }
});

test("a send that fails for good reaches its member's app once, and nobody else's", async () => {
  const { db } = database;
  const org = await createOrg(db, "failing");
  const ana = await createMember(db, org.id, "ana@failing.test");
  const bea = await createMember(db, org.id, "bea@failing.test");
  // The mail service cannot open this mailbox, so nothing can ever send from it.
  const broken = await createMailbox(db, org.id, "broken@failing.test");
  await grant(db, org.id, broken.id, ana.id);
  await grant(db, org.id, broken.id, bea.id);

  const anaCookie = await signIn(worker, db, "ana@failing.test");
  const beaCookie = await signIn(worker, db, "bea@failing.test");
  const anaSocket = await openRealtime(worker, anaCookie);
  const beaSocket = await openRealtime(worker, beaCookie);

  const send = await api("/send", anaCookie, {
    method: "POST",
    headers: { "idempotency-key": `doomed-send-${broken.id}` },
    body: JSON.stringify({
      mailboxId: broken.id,
      to: ["someone@outside.test"],
      subject: "Hello",
      text: "Hi",
    }),
  });
  expect(send.status).toBe(202);
  const { actionId } = (await send.json()) as { actionId: string };

  // A short, user-safe error: not the mail service's "unknown mailbox <id>".
  const failure = {
    type: "action",
    actionId,
    kind: "send",
    status: "failed",
    error: "The message could not be sent.",
  };
  expect(await anaSocket.next(1, 20_000)).toEqual([failure]);

  // The mail service may deliver the event again (a timeout, a retry): Ana hears it once.
  const again = await postMailEvents(worker, {
    events: [{ type: "action.failed", orgId: org.id, mailboxId: broken.id, actionId }],
  });
  expect(again.status).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(anaSocket.received).toEqual([failure]);
  // Bea sees the mailbox but did not send: her app hears nothing.
  expect(beaSocket.received).toEqual([]);

  // After a reconnect the app asks; only Ana may.
  const status = await api(`/actions/${actionId}`, anaCookie);
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({
    id: actionId,
    kind: "send",
    status: "failed",
    attempts: 1,
    error: "The message could not be sent.",
  });
  expect((await api(`/actions/${actionId}`, beaCookie)).status).toBe(404);

  anaSocket.socket.close();
  beaSocket.socket.close();
});
