// Needs reply and Awaiting reply, end to end. Real mail goes through GreenMail in both directions:
// the other side over SMTP, the reader the way a desktop client does it (SMTP, then a copy
// appended to Sent). The real mail service syncs it into Postgres and signs events to the real
// Worker, whose queue consumer triages each thread, and the lanes are read back through the
// member API. TypeSafe is the one outside service: an HTTP server answers with the Jev responses
// recorded live in `fixtures/triage/recordings`, and answers nothing it has no recording for.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { serve } from "@hono/node-server";
import type { MailEventsBody } from "@omni/contracts";
import { parseKeyring } from "@omni/crypto";
import { schema } from "@omni/db";
import { createLogger, sealCredentials, startService, type MailService } from "@omni/mail";
import { AwsClient } from "aws4fetch";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  HMAC_SECRET,
  postMailEvents,
  signIn,
  startWorker,
  SYSTEM_MAIL_FROM,
  waitForEvents,
} from "./support.ts";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const greenmail = {
  host: process.env.GREENMAIL_HOST ?? "localhost",
  imapPort: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
};
/** The reader in the fixtures; each run swaps in a fresh GreenMail address. */
const FIXTURE_READER = "sam@example.com";
const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let jev: Awaited<ReturnType<typeof startJevReplay>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mail: { service: MailService; http: ReturnType<typeof serve> };

/** Answers each recorded request with its recorded response; anything else is a 500. */
async function startJevReplay() {
  const dir = new URL("triage/recordings/", fixtures);
  const recordings = readdirSync(dir).map((file) => ({
    id: file.replace(/\.json$/, ""),
    ...(JSON.parse(readFileSync(new URL(file, dir), "utf8")) as {
      request: unknown;
      response: unknown;
    }),
  }));
  const hits: string[] = [];
  const unmatched: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "null");
    const found =
      req.url === "/v1/systemone" &&
      req.headers.authorization === "Bearer recorded" &&
      recordings.find((r) => isDeepStrictEqual(r.request, body));
    if (!found) {
      unmatched.push(body);
      res.writeHead(500).end("no recording for this request");
      return;
    }
    hits.push(found.id);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(found.response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    unmatched,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function createTestBucket() {
  const options = {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:7070",
    bucket: `omni-e2e-${randomUUID().slice(0, 8)}`,
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "omni-local",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "omni-local-secret",
    region: process.env.S3_REGION ?? "auto",
  };
  const response = await new AwsClient({ ...options, service: "s3" }).fetch(
    `${options.endpoint}/${options.bucket}`,
    {
      method: "PUT",
      body: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${options.region}</LocationConstraint></CreateBucketConfiguration>`,
    },
  );
  if (!response.ok) throw new Error(`create bucket failed: ${response.status}`);
  return options;
}

beforeAll(async () => {
  database = await createTestDatabase();
  jev = await startJevReplay();
  const mailPort = await freePort();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: `http://127.0.0.1:${mailPort}`,
    vars: { TYPESAFE_API_URL: jev.url },
    secrets: { TYPESAFE_API_KEY: "recorded" },
  });
  const bucket = await createTestBucket();
  const service = await startService(
    {
      DATABASE_URL: database.url,
      MAIL_CREDENTIALS_KEY: keyring,
      MAIL_SERVICE_HMAC_SECRET: HMAC_SECRET,
      WORKER_URL: String(worker.url),
      S3_ENDPOINT: bucket.endpoint,
      S3_BUCKET: bucket.bucket,
      S3_ACCESS_KEY_ID: bucket.accessKeyId,
      S3_SECRET_ACCESS_KEY: bucket.secretAccessKey,
      S3_REGION: bucket.region,
      IMAGE_PROXY_URL: "/api/image-proxy",
      ATTACHMENT_URL: "/api/attachments",
      // INBOX is live through IDLE; Sent is picked up by this periodic sync.
      SYNC_INTERVAL_MS: 500,
      OUTBOX_INTERVAL_MS: 60 * 60_000,
      MAILBOX_CONCURRENCY: 2,
    },
    createLogger("error"),
  );
  const http = serve({ fetch: service.app.fetch, port: mailPort, hostname: "127.0.0.1" });
  mail = { service, http };

  // Magic links go out from a disabled mailbox in its own org, which the mail service leaves
  // alone; sign-in reads the link from the outbox, so it never has to be sent.
  const system = await createOrg(database.db, "system");
  const systemBox = await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
  await database.db
    .update(schema.mailboxes)
    .set({ status: "disabled" })
    .where(eq(schema.mailboxes.id, systemBox.id));
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => (mail?.http ? mail.http.close(resolve) : resolve(undefined)));
  await mail?.service.stop();
  await worker?.server.close();
  await jev?.close();
  await database?.teardown();
});

/** A connected GreenMail mailbox for the reader, a member who can read it, and a session. */
async function setUpReader() {
  const { db } = database;
  const address = `reader-${randomUUID().slice(0, 8)}@omni.test`;
  const imap = { host: greenmail.host, port: greenmail.imapPort, secure: false };
  // A desktop client's Sent folder, there before the mail service first connects.
  await withImap(address, (client) => client.mailboxCreate("Sent").then(() => undefined));

  const org = await createOrg(db, "studio");
  const member = await createMember(db, org.id, address);
  const id = randomUUID();
  await db.insert(schema.mailboxes).values({
    id,
    orgId: org.id,
    address,
    kind: "personal",
    credentialsEnc: await sealCredentials(keyring, id, {
      user: address,
      pass: "unused",
      imap,
      smtp: { host: greenmail.host, port: greenmail.smtpPort, secure: false },
    }),
  });
  await grant(db, org.id, id, member.id);
  await mail.service.reconcileMailboxes();
  await waitUntil(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, id));
    return row?.status === "active";
  });
  return { address, mailboxId: id, orgId: org.id, cookie: await signIn(worker, db, address) };
}

async function withImap<T>(user: string, task: (client: ImapFlow) => Promise<T>) {
  const client = new ImapFlow({
    host: greenmail.host,
    port: greenmail.imapPort,
    secure: false,
    auth: { user, pass: "unused" },
    logger: false,
  });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.logout();
  }
}

/** A fixture with the reader's address swapped in. */
function eml(name: string, reader: string) {
  return readFileSync(new URL(`eml/${name}`, fixtures), "utf8").replaceAll(FIXTURE_READER, reader);
}

function header(raw: string, name: string) {
  return raw.match(new RegExp(`^${name}: *(.+)$`, "mi"))?.[1]?.trim() ?? "";
}

async function smtp(raw: string, from: string, to: string) {
  const transport = createTransport({
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  try {
    await transport.sendMail({ envelope: { from, to: [to] }, raw });
  } finally {
    transport.close();
  }
}

/** The other side writes to the reader. */
async function arrives(name: string, reader: { address: string }) {
  const raw = eml(name, reader.address);
  await smtp(raw, "lucia@northwind.example", reader.address);
  return header(raw, "Message-ID");
}

/** The reader replies from a desktop client: SMTP out, then a copy into Sent. */
async function readerSends(name: string, reader: { address: string }) {
  const raw = eml(name, reader.address);
  await smtp(raw, reader.address, "lucia@northwind.example");
  await withImap(reader.address, (client) => client.append("Sent", raw, ["\\Seen"]));
  return header(raw, "Message-ID");
}

async function waitUntil<T>(check: () => Promise<T | false | undefined>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      const extra = jev.unmatched.length
        ? `; Jev requests with no recording: ${JSON.stringify(jev.unmatched).slice(0, 2_000)}`
        : "";
      throw new Error(`timed out after ${timeoutMs}ms${extra}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits until the thread holding `messageIdHeader` is triaged on that message; returns it. */
async function triagedOn(mailboxId: string, messageIdHeader: string) {
  const { db } = database;
  return waitUntil(async () => {
    const [message] = await db
      .select({ id: schema.messages.id, threadId: schema.messages.threadId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.mailboxId, mailboxId),
          eq(schema.messages.messageIdHeader, messageIdHeader),
        ),
      );
    if (!message) return false;
    const [thread] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, message.threadId));
    return thread?.triageMessageId === message.id && { ...thread, messageId: message.id };
  });
}

const LANES = ["needs_reply", "waiting_on_them", "fyi", "noise", "unsure"] as const;

/** Every lane the member API lists the thread in. */
async function lanesOf(reader: { cookie: string; mailboxId: string }, threadId: string) {
  const found: string[] = [];
  for (const lane of LANES) {
    const response = await fetch(
      new URL(`/api/threads?mailboxId=${reader.mailboxId}&lane=${lane}`, worker.url),
      { headers: { cookie: reader.cookie } },
    );
    expect(response.status).toBe(200);
    const { threads } = (await response.json()) as { threads: { id: string }[] };
    if (threads.some((t) => t.id === threadId)) found.push(lane);
  }
  return found;
}

test("a thread moves between Needs reply and Awaiting reply as each side writes, and out when the reader closes it", async () => {
  const reader = await setUpReader();

  // Lucía asks for two things: the reader owes a reply.
  const first = await triagedOn(
    reader.mailboxId,
    await arrives("triage-inbound-request.eml", reader),
  );
  expect(first).toMatchObject({ triage: "needs_reply", triageSource: "ai" });
  expect(await lanesOf(reader, first.id)).toEqual(["needs_reply"]);

  // The reader answers with a question of their own: now they wait on her.
  const second = await triagedOn(
    reader.mailboxId,
    await readerSends("triage-reader-question.eml", reader),
  );
  expect(second.id).toBe(first.id);
  expect(await lanesOf(reader, first.id)).toEqual(["waiting_on_them"]);

  // She answers and asks something back: it's the reader's turn again.
  await triagedOn(reader.mailboxId, await arrives("triage-inbound-answer-asks.eml", reader));
  expect(await lanesOf(reader, first.id)).toEqual(["needs_reply"]);

  // The reader answers and thanks her, asking nothing: the thread leaves both lanes.
  const closed = await triagedOn(
    reader.mailboxId,
    await readerSends("triage-reader-thanks.eml", reader),
  );
  expect(closed).toMatchObject({ triage: "fyi", triageSource: "ai" });
  expect(await lanesOf(reader, first.id)).toEqual(["fyi"]);

  // One Jev call per message, each one recorded for exactly this thread state.
  expect(jev.unmatched).toEqual([]);
  expect(jev.hits.filter((id) => id.startsWith("kickoff-"))).toEqual([
    "kickoff-1",
    "kickoff-2",
    "kickoff-3",
    "kickoff-4",
  ]);
}, 120_000);

test("an FYI and an automated receipt land in neither reply lane", async () => {
  const reader = await setUpReader();
  for (const fixture of ["triage-inbound-fyi.eml", "triage-automated-receipt.eml"]) {
    const thread = await triagedOn(reader.mailboxId, await arrives(fixture, reader));
    expect(await lanesOf(reader, thread.id)).toEqual(["fyi"]);
  }
}, 60_000);

test("a redelivered job costs no model call and keeps a person's re-sort; the next message re-triages", async () => {
  const { db } = database;
  const reader = await setUpReader();
  const thread = await triagedOn(
    reader.mailboxId,
    await arrives("triage-inbound-request.eml", reader),
  );
  const calls = jev.hits.length;

  // A person decides it's only an FYI.
  await db
    .update(schema.threads)
    .set({ triage: "fyi", triageSource: "person" })
    .where(eq(schema.threads.id, thread.id));

  // The mail service may deliver the same event again after a timeout.
  const event: MailEventsBody = {
    events: [
      {
        type: "message.created",
        folderRole: "inbox",
        orgId: reader.orgId,
        mailboxId: reader.mailboxId,
        threadId: thread.id,
        messageId: thread.messageId,
      },
    ],
  };
  const forThread = (e: Record<string, unknown>) =>
    e.event === "ai.job" && e.threadId === thread.id;
  const before = (await waitForEvents(worker, forThread)).length;
  expect((await postMailEvents(worker, event)).status).toBe(202);
  const [redelivered] = (await waitForEvents(worker, forThread, before + 1)).slice(before);
  expect(redelivered?.outcome).toBe("done_already");
  expect(jev.hits.length).toBe(calls);
  expect(await lanesOf(reader, thread.id)).toEqual(["fyi"]);

  // New mail on the thread is a new question: the re-sort covered the old message only.
  await triagedOn(reader.mailboxId, await readerSends("triage-reader-question.eml", reader));
  const [after] = await db.select().from(schema.threads).where(eq(schema.threads.id, thread.id));
  expect(after).toMatchObject({ triage: "waiting_on_them", triageSource: "ai" });
  expect(await lanesOf(reader, thread.id)).toEqual(["waiting_on_them"]);
}, 90_000);
