// One request ID, end to end: a member's click reaches the Worker with `x-request-id`, rides the
// signed ping to the mail service and the outbox row, and shows in both processes' logs. An action
// that fails for good shows in the dead-letter listing (the real CLI) with its error and that ID.
// Real Worker (workerd), real mail service, real GreenMail and Postgres.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { parseKeyring } from "@omni/crypto";
import { schema } from "@omni/db";
import { createLogger, sealCredentials, startService, type MailService } from "@omni/mail";
import { and, eq } from "drizzle-orm";
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
  waitForEvents,
  workerEvents,
} from "./support.ts";

const greenmail = {
  host: process.env.GREENMAIL_HOST ?? "localhost",
  imapPort: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
};
const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);
const mailApp = join(import.meta.dirname, "../../mail");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mail: { service: MailService; http: ReturnType<typeof serve> };
/** Every line the mail service logged, parsed: its real logger, writing here instead of stdout. */
const mailLog: Record<string, unknown>[] = [];

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
      // Only the Worker's ping runs the outbox, so each action is the request's own doing.
      OUTBOX_INTERVAL_MS: 60 * 60_000,
      MAILBOX_CONCURRENCY: 2,
    },
    createLogger("debug", {}, { write: (line) => mailLog.push(JSON.parse(line)) }),
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

/** A connected GreenMail mailbox with one received thread, its member, and a session. */
async function setUpMember() {
  const { db } = database;
  const address = `trace-${randomUUID().slice(0, 8)}@omni.test`;
  const org = await createOrg(db, "trace");
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

  const transport = createTransport({
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  await transport.sendMail({
    from: "lucia@northwind.example",
    to: address,
    subject: "Kickoff",
    text: "Can we meet Tuesday?",
  });
  transport.close();
  const thread = await waitUntil(async () => {
    const [row] = await db.select().from(schema.threads).where(eq(schema.threads.mailboxId, id));
    return row;
  });
  return {
    orgId: org.id,
    mailboxId: id,
    threadId: thread.id,
    cookie: await signIn(worker, db, address),
  };
}

function post(path: string, cookie: string, requestId: string, body: unknown = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      "x-request-id": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function action(id: string) {
  const [row] = await database.db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.id, id));
  return row!;
}

test("a send's request ID is in the Worker's logs, the outbox row and the mail service's logs", async () => {
  const member = await setUpMember();
  const requestId = `e2e-send-${randomUUID()}`;

  const response = await post(`/threads/${member.threadId}/reply`, member.cookie, requestId, {
    text: "Tuesday works.",
  });
  expect(response.status).toBe(202);
  expect(response.headers.get("x-request-id")).toBe(requestId);
  const { actionId } = (await response.json()) as { actionId: string };

  await waitUntil(async () => (await action(actionId)).status === "done");
  expect((await action(actionId)).requestId).toBe(requestId);

  // Worker: the request itself, by route pattern and org, and the signed ping it sent.
  const [request] = await waitForEvents(
    worker,
    (e) => e.event === "http.request" && e.requestId === requestId,
  );
  expect(request).toMatchObject({
    level: "info",
    component: "api",
    method: "POST",
    route: "/api/threads/:id/reply",
    status: 202,
    orgId: member.orgId,
  });
  expect(request!.durationMs).toEqual(expect.any(Number));
  await waitForEvents(
    worker,
    (e) => e.event === "mail_service.ping" && e.requestId === requestId && e.status === 202,
  );

  // Mail service: the ping arrived under the same ID, and the outbox ran the send under it.
  expect(mailLog).toContainEqual(
    expect.objectContaining({ event: "outbox.pinged", requestId, component: "http" }),
  );
  expect(mailLog).toContainEqual(
    expect.objectContaining({
      event: "outbox.done",
      component: "outbox",
      requestId,
      actionId,
      orgId: member.orgId,
      kind: "send",
      durationMs: expect.any(Number),
    }),
  );

  // Nothing either side logged carries the message text.
  const everything = JSON.stringify([...workerEvents(worker), ...mailLog]);
  expect(everything).not.toContain("Tuesday works.");
  expect(everything).not.toContain("Can we meet Tuesday?");
});

test("an action that fails for good is listed by the dead-letter CLI with its error and request ID", async () => {
  const member = await setUpMember();
  // The app's view of INBOX is stale (its UIDVALIDITY moved on the server): archiving can never
  // succeed, so the mail service fails the action without retrying.
  await database.db
    .update(schema.mailboxFolders)
    .set({ uidvalidity: 1 })
    .where(
      and(
        eq(schema.mailboxFolders.mailboxId, member.mailboxId),
        eq(schema.mailboxFolders.path, "INBOX"),
      ),
    );
  const requestId = `e2e-archive-${randomUUID()}`;
  const response = await post(`/threads/${member.threadId}/archive`, member.cookie, requestId);
  expect(response.status).toBe(200);
  const { actionIds } = (await response.json()) as { actionIds: string[] };
  expect(actionIds).toHaveLength(1);
  await waitUntil(async () => (await action(actionIds[0]!)).status === "failed");

  // The Worker hears about it and logs the original request's ID next to the action.
  await waitForEvents(
    worker,
    (e) =>
      e.event === "action.failed" && e.actionId === actionIds[0] && e.actionRequestId === requestId,
  );

  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["src/cli/dead-letters.ts", "--json", "--org", member.orgId],
    { cwd: mailApp, env: { ...process.env, DATABASE_URL: database.url } },
  );
  const entries = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(entries).toEqual([
    expect.objectContaining({
      source: "outbox",
      id: actionIds[0],
      orgId: member.orgId,
      kind: "archive",
      requestId,
      error: expect.stringContaining("UIDVALIDITY"),
      ref: expect.objectContaining({ mailboxId: member.mailboxId }),
    }),
  ]);
});
