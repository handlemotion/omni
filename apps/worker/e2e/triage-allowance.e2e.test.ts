// The monthly AI triage allowance (ADR 0014), end to end. Real mail arrives over GreenMail, the
// real mail service syncs it and signs events to the real Worker, and the queue consumer triages
// with Jev answers replayed from `fixtures/triage/recordings`. The workspace's plan comes from a
// signed Stripe webhook. Each AI-triaged email counts once; past the allowance mail still
// arrives and reads, triage pauses with the date it resumes, and the next period triages again.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { serve } from "@hono/node-server";
import { parseKeyring } from "@omni/crypto";
import { schema } from "@omni/db";
import { createLogger, sealCredentials, startService, type MailService } from "@omni/mail";
import { AwsClient } from "aws4fetch";
import { and, eq } from "drizzle-orm";
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
} from "./support.ts";
import {
  BILLING_SECRETS,
  MONTHLY_PRICE,
  postStripeEvent,
  stripeEvent,
  subscriptionObject,
} from "./stripe-events.ts";

const ALLOWANCE = 2;
/** Stripe timestamps are whole seconds. */
const second = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
const fixtures = new URL("../../../fixtures/", import.meta.url);
const greenmail = {
  host: process.env.GREENMAIL_HOST ?? "localhost",
  imapPort: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
};
const FIXTURE_READER = "sam@example.com";
const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let jev: Awaited<ReturnType<typeof startJevReplay>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mail: { service: MailService; http: ReturnType<typeof serve> };

/** Answers each recorded Jev request with its recorded response; anything else is a 500. */
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
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "null");
    const found = recordings.find((r) => isDeepStrictEqual(r.request, body));
    if (!found) {
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
    vars: {
      TYPESAFE_API_URL: jev.url,
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      BILLING_TRIAGE_ALLOWANCE: String(ALLOWANCE),
    },
    secrets: { TYPESAFE_API_KEY: "recorded", ...BILLING_SECRETS },
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
      SYNC_INTERVAL_MS: 500,
      OUTBOX_INTERVAL_MS: 60 * 60_000,
      MAILBOX_CONCURRENCY: 2,
    },
    createLogger("error"),
  );
  mail = {
    service,
    http: serve({ fetch: service.app.fetch, port: mailPort, hostname: "127.0.0.1" }),
  };

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

/** A paid workspace with a live GreenMail inbox, its owner signed in. */
async function setUpWorkspace() {
  const { db } = database;
  const address = `reader-${randomUUID().slice(0, 8)}@omni.test`;
  const org = await createOrg(db, "allowance");
  const customer = `cus_e2e_${randomUUID().slice(0, 8)}`;
  await db
    .update(schema.organizations)
    .set({ stripeCustomerId: customer })
    .where(eq(schema.organizations.id, org.id));
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
      imap: { host: greenmail.host, port: greenmail.imapPort, secure: false },
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
  return {
    address,
    orgId: org.id,
    mailboxId: id,
    customer,
    cookie: await signIn(worker, db, address),
  };
}

async function arrives(name: string, reader: { address: string; mailboxId: string }) {
  const raw = readFileSync(new URL(`eml/${name}`, fixtures), "utf8").replaceAll(
    FIXTURE_READER,
    reader.address,
  );
  const transport = createTransport({
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  try {
    await transport.sendMail({
      envelope: { from: "lucia@northwind.example", to: [reader.address] },
      raw,
    });
  } finally {
    transport.close();
  }
  const messageIdHeader = raw.match(/^Message-ID: *(.+)$/im)![1]!.trim();
  // Stored by the mail service: the email arrived, whatever triage does next.
  return waitUntil(async () => {
    const [message] = await database.db
      .select({ id: schema.messages.id, threadId: schema.messages.threadId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.mailboxId, reader.mailboxId),
          eq(schema.messages.messageIdHeader, messageIdHeader),
        ),
      );
    return message;
  });
}

async function threadRow(threadId: string) {
  const [thread] = await database.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  return thread!;
}

async function usageRows(orgId: string) {
  return database.db
    .select({
      periodStart: schema.triageUsage.periodStart,
      messageId: schema.triageUsage.messageId,
    })
    .from(schema.triageUsage)
    .where(eq(schema.triageUsage.orgId, orgId));
}

async function billing(cookie: string) {
  const response = await fetch(new URL("/api/billing", worker.url), { headers: { cookie } });
  return (await response.json()) as {
    triage: { used: number; allowance: number; periodEnd: string; pausedUntil: string | null };
  };
}

/** Delivers the thread's AI job again, the way a queue redelivery or a re-sync would. */
async function redeliver(
  reader: { orgId: string; mailboxId: string },
  message: { id: string; threadId: string },
) {
  const response = await postMailEvents(worker, {
    events: [
      {
        type: "message.created",
        orgId: reader.orgId,
        mailboxId: reader.mailboxId,
        threadId: message.threadId,
        messageId: message.id,
        folderRole: "inbox",
      },
    ],
  });
  expect(response.status).toBe(202);
}

async function waitUntil<T>(check: () => Promise<T | false | undefined>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("each triaged email counts once; past the allowance mail arrives untriaged until the next period", async () => {
  const reader = await setUpWorkspace();
  const subscriptionId = `sub_e2e_${randomUUID().slice(0, 8)}`;
  const firstStart = second(Date.now() - 86_400_000);
  const firstEnd = new Date(firstStart.getTime() + 30 * 86_400_000);
  const subscribed = await postStripeEvent(
    worker.url,
    stripeEvent(
      "customer.subscription.created",
      subscriptionObject({
        id: subscriptionId,
        customer: reader.customer,
        status: "active",
        periodStart: firstStart,
        periodEnd: firstEnd,
      }),
      new Date(Date.now() - 60_000),
    ),
  );
  expect(subscribed.body).toMatchObject({ applied: true });

  // 1. Triaged and counted.
  const request = await arrives("triage-inbound-request.eml", reader);
  await waitUntil(async () => (await threadRow(request.threadId)).triageMessageId === request.id);
  expect(await usageRows(reader.orgId)).toEqual([
    { periodStart: firstStart, messageId: request.id },
  ]);

  // A redelivered job for an email already triaged costs nothing and counts nothing...
  await redeliver(reader, request);
  // ...and a job retried after the model ran but before the triage was saved runs again without
  // counting twice: forget the saved triage to put the thread back in that state.
  await database.db
    .update(schema.threads)
    .set({ triageMessageId: null })
    .where(eq(schema.threads.id, request.threadId));
  await redeliver(reader, request);
  await waitUntil(async () => (await threadRow(request.threadId)).triageMessageId === request.id);
  expect(jev.hits.filter((id) => id === "kickoff-1")).toHaveLength(2);
  expect(await usageRows(reader.orgId)).toHaveLength(1);

  // 2. The second email uses the rest of the allowance.
  const fyi = await arrives("triage-inbound-fyi.eml", reader);
  await waitUntil(async () => (await threadRow(fyi.threadId)).triageMessageId === fyi.id);
  expect(await billing(reader.cookie)).toMatchObject({
    triage: { used: 2, allowance: ALLOWANCE, pausedUntil: firstEnd.toISOString() },
  });

  // 3. Over the allowance: the email is synced and readable, not triaged, and says until when.
  const receipt = await arrives("triage-automated-receipt.eml", reader);
  const paused = await waitUntil(async () => {
    const thread = await threadRow(receipt.threadId);
    return thread.triagePausedUntil && thread;
  });
  expect(paused).toMatchObject({
    triage: null,
    triageMessageId: null,
    triagePausedUntil: firstEnd,
  });
  expect(jev.hits).not.toContain("receipt-1");
  expect(await usageRows(reader.orgId)).toHaveLength(2);
  const read = await fetch(new URL(`/api/threads/${receipt.threadId}`, worker.url), {
    headers: { cookie: reader.cookie },
  });
  expect(read.status).toBe(200);
  // What the inbox shows: "AI triage paused until <date>".
  expect(await read.json()).toMatchObject({
    triage: null,
    triagePausedUntil: firstEnd.toISOString(),
  });
  // Mail writes still work: paid, only triage is paused.
  const archived = await fetch(new URL(`/api/threads/${receipt.threadId}/archive`, worker.url), {
    method: "POST",
    headers: {
      cookie: reader.cookie,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ archived: false }),
  });
  expect(archived.status).toBe(200);

  // 4. The subscription renews: a new period, a fresh allowance, and the paused thread triages
  // on its next job.
  const renewed = await postStripeEvent(
    worker.url,
    stripeEvent(
      "customer.subscription.updated",
      subscriptionObject({
        id: subscriptionId,
        customer: reader.customer,
        status: "active",
        // Renewed early, as if the month were over: the period starts now.
        periodStart: second(Date.now() - 1000),
        periodEnd: second(Date.now() + 30 * 86_400_000),
      }),
      new Date(),
    ),
  );
  expect(renewed.body).toMatchObject({ applied: true });
  await redeliver(reader, receipt);
  const resumed = await waitUntil(async () => {
    const thread = await threadRow(receipt.threadId);
    return thread.triageMessageId === receipt.id && thread;
  });
  expect(resumed).toMatchObject({ triagePausedUntil: null, triageSource: "ai" });
  expect(jev.hits).toContain("receipt-1");
  expect(await billing(reader.cookie)).toMatchObject({ triage: { used: 1, pausedUntil: null } });
}, 120_000);
