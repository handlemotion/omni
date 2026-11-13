// The whole mail service in-process against the real local stack: Postgres, GreenMail, the S3
// gateway, and real HTTP in both directions. The Worker side is a plain HTTP server that checks
// signatures and bodies with the same `@omni/crypto` and `@omni/contracts` code the Worker uses.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { schema } from "@omni/db";
import { createMember, createOrg } from "@omni/db/testing";
import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import {
  GOOGLE_DISCONNECT_PATH,
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
import {
  deliver,
  GREENMAIL_PASSWORD,
  logger,
  mailbox,
  otherClient,
  waitFor,
} from "./support/greenmail.ts";
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
/** While true the Worker answers 503, as during a deploy or an outage. */
let workerDown = false;
let workerUnavailable = 0;

let service: MailService | null = null;
let http: ReturnType<typeof serve> | null = null;
let serviceUrl = "";

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  bucket = await createTestBucket();
  worker = createServer(async (req, res) => {
    if (workerDown) {
      workerUnavailable++;
      res.writeHead(503).end();
      return;
    }
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
  workerDown = false;
  workerUnavailable = 0;
});

afterEach(async () => {
  await stopService();
});

async function startMailService(overrides: Partial<ServiceConfig> = {}) {
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
    ...overrides,
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
    pass: GREENMAIL_PASSWORD,
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

  it("never loses new mail's event: a Worker outage and a restart still deliver it once", async () => {
    const { box, orgId } = await seedConnectable();
    workerDown = true;
    await startMailService();
    await connected(box.id);

    await deliver(box.address, "during the outage");
    const [row] = await waitFor(async () => {
      const rows = await stored(db, box.id, "INBOX");
      return rows.length > 0 && rows;
    });
    await waitFor(() => workerUnavailable > 0);
    // The process goes away before the Worker ever accepted the event.
    await stopService();
    expect(received).toEqual([]);

    workerDown = false;
    await startMailService();
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
    // Accepted, so the next start sends nothing again.
    await waitFor(async () => (await messageRows(db, box.id))[0]?.notifyPending === false);
  });

  it("never loses a failed action's event: a Worker outage and a restart still deliver it once", async () => {
    const seeded = await seedConnectable();
    const { box } = seeded;
    workerDown = true;
    await startMailService();
    await connected(box.id);

    // Its folder was reset since the app saw it: it fails for good on the first attempt.
    const stale = await enqueue(db, seeded, {
      kind: "move",
      idempotencyKey: `stale-move-outage-${box.id}`,
      payload: { folder: "INBOX", uidValidity: "1", uids: [1], destination: "Archive" },
    });
    await service?.supervisor.ping();
    expect((await actionRow(db, stale.id)).status).toBe("failed");
    await waitFor(() => workerUnavailable > 0);
    // The process goes away before the Worker ever accepted the event.
    await stopService();
    expect(received).toEqual([]);

    workerDown = false;
    await startMailService();
    await waitFor(() => received.length > 0);
    expect(received).toEqual([
      {
        type: "action.failed",
        orgId: seeded.orgId,
        mailboxId: box.id,
        actionId: stale.id,
        memberId: seeded.ownerId,
        error: expect.stringContaining("UIDVALIDITY"),
        requestId: null,
      },
    ]);
    // Accepted, so nothing is left to send again.
    await waitFor(
      async () =>
        (
          await db
            .select()
            .from(schema.pendingMailEvents)
            .where(eq(schema.pendingMailEvents.mailboxId, box.id))
        ).length === 0,
    );
  });

  it("a send held for undo leaves when its window ends, not at the next poll", async () => {
    const seeded = await seedConnectable();
    const { box } = seeded;
    const recipient = mailbox();
    await startMailService();
    await connected(box.id);

    // The Worker queues it with a 2 s undo window and pings at once (the poll here is an hour).
    const action = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `undo-send-${box.id}`,
      payload: { from: box.address, to: [recipient.address], subject: "after undo", text: "hi" },
    });
    await db
      .update(schema.mailActions)
      .set({ runAfter: new Date(Date.now() + 2_000) })
      .where(eq(schema.mailActions.id, action.id));
    const queuedAt = Date.now();
    const valid = await signRequest({
      secret,
      method: "POST",
      path: MAIL_PING_PATH,
      nonce: randomUUID(),
    });
    expect((await ping({ headers: valid })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await actionRow(db, action.id)).status).toBe("pending");

    await waitFor(async () => (await actionRow(db, action.id)).status === "done", 10_000);
    expect(Date.now() - queuedAt).toBeLessThan(6_000);
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
    // Its Sent copy carries \\Seen, so the new thread now reads as read: open apps refresh it.
    await waitFor(() => received.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toHaveLength(2);
    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ folderRole: "sent", messageId: sent[0]?.messageId }),
        expect.objectContaining({ type: "threads.changed", threadIds: [sent[0]?.threadId] }),
      ]),
    );
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
      cwd: join(import.meta.dirname, ".."),
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

describe("what the app learns about its own actions", () => {
  it("sends under the Worker's Message-ID, and reports an action that failed for good", async () => {
    const seeded = await seedConnectable();
    const { box } = seeded;
    const recipient = mailbox();
    await startMailService();
    await connected(box.id);

    const domain = box.address.split("@")[1];
    const chosen = `<${randomUUID()}@${domain}>`;
    const send = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `worker-id-send-${box.id}`,
      payload: {
        from: box.address,
        to: [recipient.address],
        subject: "pending",
        text: "hi",
        messageId: chosen,
      },
    });
    // Its folder was reset since the app saw it: retrying can never succeed.
    const stale = await enqueue(db, seeded, {
      kind: "move",
      idempotencyKey: `stale-move-${box.id}`,
      payload: { folder: "INBOX", uidValidity: "1", uids: [1], destination: "Archive" },
    });
    const headers = await signRequest({
      secret,
      method: "POST",
      path: MAIL_PING_PATH,
      nonce: randomUUID(),
    });
    expect((await ping({ headers })).status).toBe(202);

    await waitFor(async () => (await actionRow(db, send.id)).status === "done", 10_000);
    // The thread gets the Sent copy under the id the app is already showing.
    expect((await stored(db, box.id, "Sent")).map((r) => r.messageIdHeader)).toEqual([chosen]);

    await waitFor(() => received.some((e) => e.type === "action.failed"), 10_000);
    expect((await actionRow(db, stale.id)).status).toBe("failed");
    expect(received.filter((e) => e.type === "action.failed")).toEqual([
      {
        type: "action.failed",
        orgId: seeded.orgId,
        mailboxId: box.id,
        actionId: stale.id,
        memberId: seeded.ownerId,
        error: expect.stringContaining("UIDVALIDITY"),
        // Enqueued straight into Postgres here, not through a Worker request.
        requestId: null,
      },
    ]);
  });
});

describe("what the app learns from other mail apps", () => {
  it("shows mail read or archived in Apple Mail within seconds, not at the next poll", async () => {
    const { box, orgId, ownerId } = await seedConnectable();
    await otherClient(box, (client) => client.mailboxCreate("Archive").then(() => {}));
    await startMailService();
    await connected(box.id);
    await deliver(box.address, "handled elsewhere");
    const [row] = await waitFor(async () => {
      const rows = await stored(db, box.id, "INBOX");
      return rows.length > 0 && rows;
    });
    const threadId = row?.threadId ?? "missing";
    await waitFor(() => received.length > 0);
    received = [];
    const changed = { type: "threads.changed", orgId, mailboxId: box.id, threadIds: [threadId] };
    const inOtherApp = (task: (client: ImapFlow) => Promise<unknown>) =>
      otherClient(box, async (client) => {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await task(client);
        } finally {
          lock.release();
        }
      });

    // Read there: IDLE's FETCH brings the flag, and open apps hear about it. The poll is an
    // hour away, so only the live path can pass within 5s.
    await inOtherApp((client) => client.messageFlagsAdd("1:*", ["\\Seen"]));
    await waitFor(() => received.length > 0, 5_000);
    expect(received).toEqual([changed]);
    const [state] = await db
      .select({ read: schema.threadState.read })
      .from(schema.threadState)
      .where(eq(schema.threadState.memberId, ownerId));
    expect(state?.read).toBe(true);

    // Archived there: INBOX's EXPUNGE sends sync to Archive, where the copy now is.
    received = [];
    await inOtherApp((client) => client.messageMove("1:*", "Archive"));
    await waitFor(() => received.length > 0, 5_000);
    expect(received).toEqual([changed]);
    const [thread] = await db
      .select({ archived: schema.threads.archived })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(thread?.archived).toBe(true);
  });
});

describe("a Google account (ADR 0023)", () => {
  it("logs in with XOAUTH2 on IMAP and SMTP, and waits for the OAuth client when it is missing", async () => {
    const seeded = await seedMailbox(db);
    const { box } = seeded;
    // GreenMail speaks XOAUTH2 like Gmail. The token is the one the code exchange stored, still
    // valid, so nothing asks Google for a new one (refreshing is proven against Google itself in
    // google-live.e2e.test.ts).
    await setCredentials(
      db,
      box.id,
      await sealCredentials(keyring, box.id, {
        oauth: "google",
        user: box.user,
        refreshToken: "never-used-while-the-access-token-is-valid",
        accessToken: `ya29.e2e-${randomUUID()}`,
        accessTokenExpiresAt: Date.now() + 60 * 60_000,
        imap: box.imap,
        smtp: box.smtp,
      }),
    );

    // A self-hoster who has not set the Google client yet sees the mailbox in error, not a crash.
    await startMailService();
    await waitFor(async () => (await mailboxStatus(db, box.id)) === "error");
    await stopService();

    await startMailService({
      GOOGLE_CLIENT_ID: "e2e.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "e2e-secret",
    });
    await connected(box.id);
    await deliver(box.address, "over xoauth2");
    await waitFor(async () => (await stored(db, box.id, "INBOX")).length > 0);

    const recipient = mailbox();
    const send = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `xoauth2-send-${box.id}`,
      payload: {
        from: box.address,
        to: [recipient.address],
        subject: "sent with a token",
        text: "hi",
      },
    });
    const headers = await signRequest({
      secret,
      method: "POST",
      path: MAIL_PING_PATH,
      nonce: randomUUID(),
    });
    expect((await ping({ headers })).status).toBe(202);
    await waitFor(async () => (await actionRow(db, send.id)).status === "done", 10_000);
    const delivered = await otherClient(recipient, async (client) => {
      await client.mailboxOpen("INBOX");
      return (await client.search({ subject: "sent with a token" }, { uid: true })) || [];
    });
    expect(delivered).toHaveLength(1);
  });

  it("disconnects only for its owner: syncing stops, the mailbox and its mail are gone, a retry is fine", async () => {
    const seeded = await seedMailbox(db);
    const { box, orgId, ownerId } = seeded;
    await db
      .update(schema.mailboxes)
      .set({ provider: "gmail" })
      .where(eq(schema.mailboxes.id, box.id));
    await setCredentials(
      db,
      box.id,
      await sealCredentials(keyring, box.id, {
        oauth: "google",
        user: box.user,
        // Not a grant Google issued: revoking it is refused, which must not block disconnecting.
        refreshToken: `1//e2e-${randomUUID()}`,
        accessToken: `ya29.e2e-${randomUUID()}`,
        accessTokenExpiresAt: Date.now() + 60 * 60_000,
        imap: box.imap,
        smtp: box.smtp,
      }),
    );
    const service = await startMailService({
      GOOGLE_CLIENT_ID: "e2e.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "e2e-secret",
    });
    await connected(box.id);
    await deliver(box.address, "before disconnecting");
    await waitFor(async () => (await stored(db, box.id, "INBOX")).length > 0);

    const disconnect = async (memberId: string) => {
      const body = JSON.stringify({ orgId, memberId, mailboxId: box.id });
      const headers = await signRequest({
        secret,
        method: "POST",
        path: GOOGLE_DISCONNECT_PATH,
        body,
        nonce: randomUUID(),
      });
      const response = await fetch(`${serviceUrl}${GOOGLE_DISCONNECT_PATH}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      });
      return { status: response.status, json: (await response.json()) as unknown };
    };

    // A teammate in the same workspace cannot cut someone's personal Gmail.
    const teammate = await createMember(db, orgId, "teammate");
    expect((await disconnect(teammate.id)).status).toBe(404);
    expect(await mailboxStatus(db, box.id)).toBe("active");

    expect(await disconnect(ownerId)).toEqual({ status: 200, json: { mailboxId: box.id } });
    expect(service.supervisor.has(box.id)).toBe(false);
    expect(await mailboxStatus(db, box.id)).toBeUndefined();
    expect(await messageRows(db, box.id)).toEqual([]);
    // The Worker retries on a timeout; the second call finds nothing left to do.
    expect(await disconnect(ownerId)).toEqual({ status: 200, json: { mailboxId: box.id } });
  });
});

describe("a mailbox finds its home (ADR 0024)", () => {
  /** A connectable GreenMail mailbox at `address`, in a Personal space of its own owner. */
  async function personalMailbox(address: string) {
    const seeded = await seedMailbox(db, { address });
    const { box } = seeded;
    await setCredentials(
      db,
      box.id,
      await sealCredentials(keyring, box.id, {
        user: box.user,
        pass: GREENMAIL_PASSWORD,
        imap: box.imap,
        smtp: box.smtp,
      }),
    );
    const [owner] = await db
      .select({ userId: schema.members.userId })
      .from(schema.members)
      .where(eq(schema.members.id, seeded.ownerId));
    await db.insert(schema.personalSpaces).values({ orgId: seeded.orgId, userId: owner!.userId });
    return { ...seeded, userId: owner!.userId };
  }

  it("moves a member's mailbox into the company that locks its domain, and syncs it there again", async () => {
    const domain = `home-${randomUUID().slice(0, 8)}.omni.test`;
    const ana = await personalMailbox(`ana@${domain}`);
    // Bea is not a member of the company: her mailbox on the same domain stays in her space.
    const bea = await personalMailbox(`bea@${domain}`);
    const running = await startMailService();
    await connected(ana.box.id);
    await deliver(ana.box.address, "before the claim");
    await waitFor(async () => (await stored(db, ana.box.id, "INBOX")).length > 0);

    const company = await createOrg(db, `acme-${randomUUID().slice(0, 8)}`);
    const [member] = await db
      .insert(schema.members)
      .values({
        id: randomUUID(),
        organizationId: company.id,
        userId: ana.userId,
        role: "member",
        createdAt: new Date(),
      })
      .returning();
    await db.insert(schema.mailDomains).values({ orgId: company.id, domain, provider: "imap" });
    await running.reconcileMailboxes();

    // The old copy and its mail are gone; the company has the mailbox, owned by Ana's member there.
    expect(await mailboxStatus(db, ana.box.id)).toBeUndefined();
    expect(await messageRows(db, ana.box.id)).toEqual([]);
    expect(running.supervisor.has(ana.box.id)).toBe(false);
    const [moved] = await mailboxesOf(db, company.id);
    expect(moved).toMatchObject({ address: ana.box.address, kind: "personal" });
    expect((await accessRows(db, moved!.id)).map((row) => [row.memberId, row.role])).toEqual([
      [member!.id, "owner"],
    ]);
    // Its login came along, re-sealed for the new id: it connects and indexes the mail again.
    await connected(moved!.id);
    await waitFor(async () => (await stored(db, moved!.id, "INBOX")).length > 0);

    // A second run finds nothing to move.
    await running.reconcileMailboxes();
    expect(await mailboxesOf(db, company.id)).toHaveLength(1);
    expect((await mailboxesOf(db, bea.orgId)).map((row) => row.id)).toEqual([bea.box.id]);
  });

  it("waits while a draft is unsent, and never takes over a shared inbox at the same address", async () => {
    const domain = `wait-${randomUUID().slice(0, 8)}.omni.test`;
    const cara = await personalMailbox(`cara@${domain}`);
    const team = await personalMailbox(`team@${domain}`);
    const running = await startMailService();
    await connected(cara.box.id);

    const company = await createOrg(db, `wait-${randomUUID().slice(0, 8)}`);
    const join = async (userId: string) => {
      const [member] = await db
        .insert(schema.members)
        .values({
          id: randomUUID(),
          organizationId: company.id,
          userId,
          role: "member",
          createdAt: new Date(),
        })
        .returning();
      return member!;
    };
    await join(cara.userId);
    const teamMember = await join(team.userId);
    // The company already runs team@ as a shared inbox, with team's owner on it.
    const [shared] = await db
      .insert(schema.mailboxes)
      .values({ orgId: company.id, address: team.box.address, kind: "shared", credentialsEnc: "x" })
      .returning();
    await db
      .insert(schema.mailboxAccess)
      .values({ orgId: company.id, mailboxId: shared!.id, memberId: teamMember.id, role: "owner" });
    const [draft] = await db
      .insert(schema.drafts)
      .values({ orgId: cara.orgId, mailboxId: cara.box.id, kind: "new", subject: "not sent yet" })
      .returning();
    await db.insert(schema.mailDomains).values({ orgId: company.id, domain, provider: "imap" });

    await running.reconcileMailboxes();
    // Cara's draft would go with the old copy: she stays put, draft and all.
    expect(await mailboxStatus(db, cara.box.id)).toBe("active");
    expect(
      await db.select().from(schema.drafts).where(eq(schema.drafts.id, draft!.id)),
    ).toHaveLength(1);
    // team@ stays in its Personal space, and the shared inbox keeps its kind and login.
    expect((await mailboxesOf(db, team.orgId)).map((row) => row.id)).toEqual([team.box.id]);
    expect(
      (await mailboxesOf(db, company.id)).map((row) => [row.address, row.kind, row.credentialsEnc]),
    ).toEqual([[team.box.address, "shared", "x"]]);

    // Once the draft is gone, the next run moves Cara.
    await db.delete(schema.drafts).where(eq(schema.drafts.id, draft!.id));
    await running.reconcileMailboxes();
    expect(await mailboxStatus(db, cara.box.id)).toBeUndefined();
    expect((await mailboxesOf(db, company.id)).map((row) => row.address).sort()).toEqual(
      [cara.box.address, team.box.address].sort(),
    );
  });
});
