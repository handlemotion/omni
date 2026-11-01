// The whole mail service in-process against the real local stack: Postgres, GreenMail, the S3
// gateway, and real HTTP in both directions. The Worker side is a plain HTTP server that checks
// signatures and bodies with the same `@omni/crypto` and `@omni/contracts` code the Worker uses.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  MAIL_EVENTS_PATH,
  MAIL_PING_PATH,
  type MailEvent,
  mailEventsBodySchema,
} from "@omni/contracts";
import { parseKeyring, signRequest, verifyRequest } from "@omni/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sealCredentials } from "../src/credentials.ts";
import { deterministicMessageId } from "../src/outbox.ts";
import { type MailService, type ServiceConfig, startService } from "../src/service.ts";
import {
  actionRow,
  createTestDatabase,
  accessRows,
  enqueue,
  mailboxesOf,
  mailboxStatus,
  messageRows,
  seedMailbox,
  seedOwner,
  setCredentials,
  stored,
  type TestDb,
} from "./support/db.ts";
import { deliver, logger, mailbox, otherClient, waitFor } from "./support/greenmail.ts";
import { createTestBucket } from "./support/objects.ts";

const secret = randomBytes(32).toString("hex");
const keyringSecret = `k1:${randomBytes(32).toString("base64")}`;
const keyring = parseKeyring(keyringSecret);
const greenmailHost = process.env.GREENMAIL_HOST ?? "localhost";
const greenmailImapPort = process.env.GREENMAIL_IMAP_PORT ?? "3143";
const greenmailSmtpPort = process.env.GREENMAIL_SMTP_PORT ?? "3025";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let bucket: Awaited<ReturnType<typeof createTestBucket>>;
let worker: Server;
let workerUrl: string;
/** Events the Worker accepted, in order. */
let received: MailEvent[] = [];
let workerRejected = 0;

let service: MailService | null = null;
let http: ReturnType<typeof serve> | null = null;
let serviceUrl = "";

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  bucket = await createTestBucket();
  worker = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const verified = await verifyRequest({
      secret,
      method: req.method ?? "",
      path: req.url ?? "",
      body,
      headers: new Headers(req.headers as Record<string, string>),
    });
    const parsed = mailEventsBodySchema.safeParse(JSON.parse(body || "null"));
    if (req.url !== MAIL_EVENTS_PATH || !verified.ok || !parsed.success) {
      workerRejected++;
      res.writeHead(401).end();
      return;
    }
    received.push(...parsed.data.events);
    res.writeHead(202).end();
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => worker.close(resolve));
  await database.teardown();
});

beforeEach(() => {
  received = [];
  workerRejected = 0;
});

afterEach(async () => {
  await stopService();
});

async function startMailService() {
  const config: ServiceConfig = {
    DATABASE_URL: database.url,
    MAIL_CREDENTIALS_KEY: keyring,
    MAIL_SERVICE_HMAC_SECRET: secret,
    WORKER_URL: workerUrl,
    S3_ENDPOINT: bucket.options.endpoint,
    S3_BUCKET: bucket.options.bucket,
    S3_ACCESS_KEY_ID: bucket.options.accessKeyId,
    S3_SECRET_ACCESS_KEY: bucket.options.secretAccessKey,
    S3_REGION: bucket.options.region,
    IMAGE_PROXY_URL: "/api/image-proxy",
    ATTACHMENT_URL: "/api/attachments",
    // Long enough that only IDLE and pings drive work during a test.
    SYNC_INTERVAL_MS: 60 * 60_000,
    OUTBOX_INTERVAL_MS: 60 * 60_000,
    MAILBOX_CONCURRENCY: 4,
  };
  service = await startService(config, logger);
  const server = serve({ fetch: service.app.fetch, port: 0, hostname: "127.0.0.1" });
  http = server;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  serviceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return service;
}

async function stopService() {
  await new Promise((resolve) => (http ? http.close(resolve) : resolve(undefined)));
  http = null;
  await service?.stop();
  service = null;
}

/** A mailbox row whose credentials the service must decrypt to connect. */
async function seedConnectable(kind: "personal" | "shared" = "personal") {
  const seeded = await seedMailbox(db, { kind });
  const { box } = seeded;
  const credentialsEnc = await sealCredentials(keyring, box.id, {
    user: box.user,
    pass: box.pass,
    imap: box.imap,
    smtp: box.smtp,
  });
  await setCredentials(db, box.id, credentialsEnc);
  return seeded;
}

/** Connected, first sync done, and the connect-time outbox drain has had its turn. */
async function connected(mailboxId: string) {
  await waitFor(async () => (await mailboxStatus(db, mailboxId)) === "active");
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function ping(init: { headers?: Record<string, string>; path?: string } = {}) {
  return fetch(`${serviceUrl}${init.path ?? MAIL_PING_PATH}`, {
    method: "POST",
    headers: init.headers,
  });
}

describe("mail service end to end", () => {
  it("indexes mail sent over SMTP within 5s and reports it to the Worker, signed", async () => {
    const { box, orgId } = await seedConnectable();
    await startMailService();
    await connected(box.id);

    const sentAt = Date.now();
    await deliver(box.address, "pipeline check");
    const [row] = await waitFor(async () => {
      const rows = await stored(db, box.id, "INBOX");
      return rows.length > 0 && rows;
    }, 5_000);
    expect(Date.now() - sentAt).toBeLessThan(5_000);
    expect(row).toMatchObject({ subject: "pipeline check", cleanText: "body of pipeline check" });
    const raw = await bucket.objects.get(row?.r2Key ?? "missing");
    expect(Buffer.from(raw ?? []).toString()).toContain("Subject: pipeline check");

    await waitFor(() => received.length > 0);
    expect(received).toEqual([
      {
        type: "message.created",
        orgId,
        mailboxId: box.id,
        threadId: row?.threadId,
        messageId: row?.messageId,
        folderRole: "inbox",
      },
    ]);
    expect(workerRejected).toBe(0);

    // A reply from outside joins the thread.
    await deliver(box.address, "Re: pipeline check", { inReplyTo: row?.messageIdHeader });
    const reply = await waitFor(async () =>
      (await stored(db, box.id, "INBOX")).find((r) => r.subject === "Re: pipeline check"),
    );
    expect(reply.threadId).toBe(row?.threadId);
  });

  it("re-syncs after a restart without duplicate rows or repeated events", async () => {
    const { box } = await seedConnectable();
    for (const n of [1, 2]) await deliver(box.address, `before restart ${n}`);
    await startMailService();
    await connected(box.id);
    await waitFor(() => received.length === 2);
    await stopService();

    await deliver(box.address, "while down");
    received = [];
    await startMailService();
    await connected(box.id);
    await waitFor(() => received.length >= 1);
    // Let any stray duplicate arrive before counting.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(received.map((e) => e.type)).toEqual(["message.created"]);
    const rows = await messageRows(db, box.id);
    expect(rows.map((r) => r.subject).toSorted()).toEqual([
      "before restart 1",
      "before restart 2",
      "while down",
    ]);
  });

  it("rejects forged, expired and replayed pings; a valid ping runs the outbox", async () => {
    const seeded = await seedConnectable();
    const { box } = seeded;
    const recipient = mailbox();
    await startMailService();
    await connected(box.id);

    const action = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `ping-send-${box.id}`,
      payload: { from: box.address, to: [recipient.address], subject: "via ping", text: "hi" },
    });

    const forged = await signRequest({
      secret: randomBytes(32).toString("hex"),
      method: "POST",
      path: MAIL_PING_PATH,
    });
    const expired = await signRequest({
      secret,
      method: "POST",
      path: MAIL_PING_PATH,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    const otherPath = await signRequest({ secret, method: "POST", path: "/elsewhere" });
    expect((await ping()).status).toBe(401);
    expect((await ping({ headers: forged })).status).toBe(401);
    expect((await ping({ headers: expired })).status).toBe(401);
    expect((await ping({ headers: otherPath })).status).toBe(401);
    // None of those ran the outbox.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await actionRow(db, action.id)).status).toBe("pending");

    const valid = await signRequest({
      secret,
      method: "POST",
      path: MAIL_PING_PATH,
      nonce: randomUUID(),
    });
    expect((await ping({ headers: valid })).status).toBe(202);
    expect((await ping({ headers: valid })).status).toBe(401); // same nonce again

    await waitFor(async () => (await actionRow(db, action.id)).status === "done", 10_000);

    // The Sent copy is indexed exactly once, and the Worker hears about it once.
    const messageId = deterministicMessageId(action.idempotencyKey, box.address);
    const sent = await stored(db, box.id, "Sent");
    expect(sent.map((r) => r.messageIdHeader)).toEqual([messageId]);
    expect((await messageRows(db, box.id)).map((r) => r.messageIdHeader)).toEqual([messageId]);
    await waitFor(() => received.length > 0);
    expect(received).toEqual([
      expect.objectContaining({ folderRole: "sent", messageId: sent[0]?.messageId }),
    ]);
    const inRecipient = await otherClient(recipient, async (client) => {
      const status = await client.status("INBOX", { messages: true });
      return status ? status.messages : -1;
    });
    expect(inRecipient).toBe(1);
  });

  it("onboards a mailbox with mailbox:add; the running service connects it and indexes mail", async () => {
    const owner = await seedOwner(db);
    await startMailService();
    const address = `onboard-${randomUUID().slice(0, 8)}@omni.test`;
    const args = [
      "--org",
      owner.orgId,
      "--address",
      address,
      "--owner",
      owner.email.toUpperCase(),
      "--provider",
      "imap",
      "--imap",
      `${greenmailHost}:${greenmailImapPort}:plain`,
      "--smtp",
      `${greenmailHost}:${greenmailSmtpPort}:plain`,
    ];

    const first = await mailboxAdd(args, "app-password-1");
    expect(first).toMatchObject({ code: 0, stderr: expect.not.stringContaining("mailbox:add:") });
    const { mailboxId } = JSON.parse(first.stdout) as { mailboxId: string };
    // The CLI pinged the service, which decrypted the credentials and connected.
    expect(first.stderr).toContain("mail service pinged");
    await connected(mailboxId);
    await deliver(address, "first onboarded mail");
    await waitFor(async () => (await stored(db, mailboxId, "INBOX")).length === 1);

    // Running it again replaces the credentials in place: same mailbox, one owner grant.
    const second = await mailboxAdd(args, "app-password-2");
    expect(second).toMatchObject({ code: 0, stderr: expect.not.stringContaining("mailbox:add:") });
    expect(JSON.parse(second.stdout)).toMatchObject({ mailboxId });
    expect(await mailboxesOf(db, owner.orgId)).toHaveLength(1);
    expect(await accessRows(db, mailboxId)).toEqual([
      expect.objectContaining({ memberId: owner.memberId, role: "owner" }),
    ]);

    // An owner outside the org is refused and writes nothing.
    const stranger = await mailboxAdd(
      [...args.slice(0, 3), `other-${address}`, "--owner", "nobody@example.test", ...args.slice(6)],
      "pw",
    );
    expect(stranger.code).toBe(1);
    expect(stranger.stderr).toContain("no member with email");
    expect(await mailboxesOf(db, owner.orgId)).toHaveLength(1);
  });
});

/** Runs the real `mailbox:add` script with the password on stdin. */
function mailboxAdd(args: string[], password: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["src/cli/mailbox-add.ts", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: database.url,
        MAIL_CREDENTIALS_KEY: keyringSecret,
        MAIL_SERVICE_URL: serviceUrl,
        MAIL_SERVICE_HMAC_SECRET: secret,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(password);
  });
}
