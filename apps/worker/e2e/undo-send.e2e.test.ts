import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { parseKeyring } from "@omni/crypto";
import { schema } from "@omni/db";
import { createLogger, sealCredentials, startService, type MailService } from "@omni/mail";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  HMAC_SECRET,
  signIn,
  startWorker,
} from "./support.ts";

const greenmail = {
  host: process.env.GREENMAIL_HOST ?? "localhost",
  imapPort: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
};
const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);
const UNDO_SECONDS = 2;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mail: { service: MailService; http: ReturnType<typeof serve> };

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  database = await createTestDatabase();
  const mailPort = await freePort();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: `http://127.0.0.1:${mailPort}`,
  });
  const service = await startService(
    {
      DATABASE_URL: database.url,
      MAIL_CREDENTIALS_KEY: keyring,
      MAIL_SERVICE_HMAC_SECRET: HMAC_SECRET,
      WORKER_URL: String(worker.url),
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:7070",
      S3_BUCKET: process.env.S3_BUCKET ?? "omni-mail-dev",
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "omni-local",
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "omni-local-secret",
      S3_REGION: process.env.S3_REGION ?? "auto",
      IMAGE_PROXY_URL: "/api/image-proxy",
      ATTACHMENT_URL: "/api/attachments",
      SYNC_INTERVAL_MS: 60 * 60_000,
      OUTBOX_INTERVAL_MS: 500,
      MAILBOX_CONCURRENCY: 2,
    },
    createLogger("error", {}, { write: () => {} }),
  );
  mail = {
    service,
    http: serve({ fetch: service.app.fetch, port: mailPort, hostname: "127.0.0.1" }),
  };
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => (mail?.http ? mail.http.close(resolve) : resolve(undefined)));
  await mail?.service.stop();
  await worker?.server.close();
  await database?.teardown();
});

async function waitUntil<T>(check: () => Promise<T | false | undefined> | T, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function inboxSubjects(address: string) {
  const client = new ImapFlow({
    host: greenmail.host,
    port: greenmail.imapPort,
    secure: false,
    auth: { user: address, pass: address },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const subjects: string[] = [];
      for await (const message of client.fetch("1:*", { envelope: true })) {
        subjects.push(message.envelope?.subject ?? "");
      }
      return subjects;
    } finally {
      lock.release();
    }
  } catch {
    return [];
  } finally {
    await client.logout();
  }
}

test("a cancelled send never leaves; one left alone goes out after the undo window", async () => {
  const { db } = database;
  const address = `undo-${randomUUID().slice(0, 8)}@omni.test`;
  const customer = `customer-${randomUUID().slice(0, 8)}@outside.test`;
  const org = await createOrg(db, "undo");
  const member = await createMember(db, org.id, address);
  await db
    .insert(schema.memberPreferences)
    .values({ memberId: member.id, orgId: org.id, undoSendSeconds: UNDO_SECONDS });
  const mailboxId = randomUUID();
  await db.insert(schema.mailboxes).values({
    id: mailboxId,
    orgId: org.id,
    address,
    kind: "personal",
    credentialsEnc: await sealCredentials(keyring, mailboxId, {
      user: address,
      pass: "unused",
      imap: { host: greenmail.host, port: greenmail.imapPort, secure: false },
      smtp: { host: greenmail.host, port: greenmail.smtpPort, secure: false },
    }),
  });
  await grant(db, org.id, mailboxId, member.id);
  await mail.service.reconcileMailboxes();
  const transport = createTransport({
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  await transport.sendMail({ from: customer, to: address, subject: "Order", text: "Where is it?" });
  transport.close();
  const thread = await waitUntil(async () => {
    const [row] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.mailboxId, mailboxId));
    return row;
  });
  const cookie = await signIn(worker, db, address);
  const reply = (text: string) =>
    fetch(new URL(`/api/threads/${thread.id}/reply`, worker.url), {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ text }),
    });

  const cancelled = await reply("Wrong order, sorry.");
  expect(cancelled.status).toBe(202);
  const held = (await cancelled.json()) as { actionId: string; undoUntil: string };
  expect(new Date(held.undoUntil).getTime()).toBeGreaterThan(Date.now());
  const cancel = await fetch(new URL(`/api/actions/${held.actionId}/cancel`, worker.url), {
    method: "POST",
    headers: { cookie, "idempotency-key": randomUUID() },
  });
  expect(cancel.status).toBe(200);

  const kept = await reply("It ships Tuesday.");
  expect(kept.status).toBe(202);
  const { actionId, undoUntil } = (await kept.json()) as { actionId: string; undoUntil: string };

  const sent = await waitUntil(async () => {
    const [row] = await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.id, actionId));
    return row?.status === "done" && row;
  });
  expect(sent.runAfter.toISOString()).toBe(undoUntil);
  expect(sent.smtpAcceptedAt?.getTime()).toBeGreaterThanOrEqual(new Date(undoUntil).getTime());
  const subjects = await waitUntil(async () => {
    const found = await inboxSubjects(customer);
    return found.length ? found : false;
  });
  expect(subjects).toEqual(["Re: Order"]);
  const [gone] = await db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.id, held.actionId));
  expect(gone).toBeUndefined();
});
