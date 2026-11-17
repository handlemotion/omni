import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAIL_PING_PATH } from "@omni/contracts";
import { getFolderPosition, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { parseKeyring, signRequest } from "@omni/crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { sealCredentials } from "../src/credentials.ts";
import { GMAIL_SERVERS } from "../src/providers/gmail.ts";
import { type MailService, startService } from "../src/service.ts";
import {
  actionRow,
  createTestDatabase,
  enqueue,
  mailboxStatus,
  seedMailbox,
  setCredentials,
  stored,
  type TestDb,
} from "./support/db.ts";
import { logger, waitFor } from "./support/greenmail.ts";
import { createTestBucket } from "./support/objects.ts";

const requested = process.env.GMAIL_E2E === "1";
const address = process.env.GMAIL_E2E_ADDRESS ?? "";
const refreshToken = process.env.GMAIL_E2E_REFRESH_TOKEN ?? "";
const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
const secret = randomBytes(32).toString("hex");
const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);

describe.runIf(requested)("Gmail itself", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: TestDb;
  let bucket: Awaited<ReturnType<typeof createTestBucket>>;
  let worker: Server;
  let service: MailService | null = null;
  let http: ReturnType<typeof serve> | null = null;
  let serviceUrl = "";

  beforeAll(async () => {
    for (const [name, value] of Object.entries({
      GMAIL_E2E_ADDRESS: address,
      GMAIL_E2E_REFRESH_TOKEN: refreshToken,
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: clientSecret,
    })) {
      if (!value) throw new Error(`GMAIL_E2E=1 needs ${name}`);
    }
    database = await createTestDatabase();
    db = database.db;
    bucket = await createTestBucket();
    worker = createServer((_req, res) => res.writeHead(202).end());
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => worker?.close(resolve));
    await database?.teardown();
  });

  afterEach(async () => {
    http?.close();
    http = null;
    await service?.stop();
    service = null;
  });

  async function start() {
    service = await startService(
      {
        DATABASE_URL: database.url,
        MAIL_CREDENTIALS_KEY: keyring,
        MAIL_SERVICE_HMAC_SECRET: secret,
        WORKER_URL: `http://127.0.0.1:${(worker.address() as AddressInfo).port}`,
        S3_ENDPOINT: bucket.options.endpoint,
        S3_BUCKET: bucket.options.bucket,
        S3_ACCESS_KEY_ID: bucket.options.accessKeyId,
        S3_SECRET_ACCESS_KEY: bucket.options.secretAccessKey,
        S3_REGION: bucket.options.region,
        IMAGE_PROXY_URL: "/api/image-proxy",
        ATTACHMENT_URL: "/api/attachments",
        SYNC_INTERVAL_MS: 60 * 60_000,
        OUTBOX_INTERVAL_MS: 60 * 60_000,
        MAILBOX_CONCURRENCY: 4,
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_CLIENT_SECRET: clientSecret,
      },
      logger,
    );
    const server = serve({ fetch: service.app.fetch, port: 0, hostname: "127.0.0.1" });
    http = server;
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    serviceUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function seedGoogle(token: string) {
    const seeded = await seedMailbox(db, { address });
    const { box } = seeded;
    await setCredentials(
      db,
      box.id,
      await sealCredentials(keyring, box.id, {
        oauth: "google",
        user: address,
        refreshToken: token,
        ...GMAIL_SERVERS,
      }),
    );
    return seeded;
  }

  it("refreshes an access token, syncs Gmail and sends through it", async () => {
    const seeded = await seedGoogle(refreshToken);
    await start();
    await waitFor(async () => (await mailboxStatus(db, seeded.box.id)) === "active", 60_000);

    const subject = `omni gmail e2e ${randomUUID()}`;
    const send = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `gmail-live-${seeded.box.id}`,
      payload: { from: address, to: [address], subject, text: "to myself, through Gmail" },
    });
    const headers = await signRequest({
      secret,
      method: "POST",
      path: MAIL_PING_PATH,
      nonce: randomUUID(),
    });
    await fetch(`${serviceUrl}${MAIL_PING_PATH}`, { method: "POST", headers });
    await waitFor(async () => (await actionRow(db, send.id)).status === "done", 60_000);
    const arrived = await waitFor(
      async () => (await stored(db, seeded.box.id, "INBOX")).find((r) => r.subject === subject),
      60_000,
    );
    expect(arrived.cleanText).toContain("to myself, through Gmail");
  });

  it("syncs Gmail's system folders only, follows its threads and archives into All Mail", async () => {
    const seeded = await seedGoogle(refreshToken);
    const mailboxId = seeded.box.id;
    await start();
    await waitFor(async () => (await mailboxStatus(db, mailboxId)) === "active", 60_000);

    const folders = await db
      .select({ path: schema.mailboxFolders.path, role: schema.mailboxFolders.role })
      .from(schema.mailboxFolders)
      .where(eq(schema.mailboxFolders.mailboxId, mailboxId));
    expect(folders.map((f) => f.role).toSorted()).toEqual(
      ["archive", "drafts", "inbox", "junk", "sent", "trash"].toSorted(),
    );
    const pathOf = (role: string) => folders.find((f) => f.role === role)?.path ?? "";

    const ping = async () =>
      fetch(`${serviceUrl}${MAIL_PING_PATH}`, {
        method: "POST",
        headers: await signRequest({
          secret,
          method: "POST",
          path: MAIL_PING_PATH,
          nonce: randomUUID(),
        }),
      });
    const subject = `omni gmail thread ${randomUUID()}`;
    const first = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `gmail-thread-1-${mailboxId}`,
      payload: { from: address, to: [address], subject, text: "first" },
    });
    await ping();
    await waitFor(async () => (await actionRow(db, first.id)).status === "done", 60_000);
    const inbound = await waitFor(
      async () => (await stored(db, mailboxId, "INBOX")).find((r) => r.subject === subject),
      60_000,
    );
    const reply = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `gmail-thread-2-${mailboxId}`,
      payload: {
        from: address,
        to: [address],
        subject: `Re: ${subject}`,
        text: "second",
        inReplyTo: inbound.messageIdHeader,
        references: [inbound.messageIdHeader],
      },
    });
    await ping();
    await waitFor(async () => (await actionRow(db, reply.id)).status === "done", 60_000);
    const replyRow = await waitFor(
      async () =>
        (await stored(db, mailboxId, "INBOX")).find((r) => r.subject === `Re: ${subject}`),
      60_000,
    );

    expect(replyRow.threadId).toBe(inbound.threadId);
    const [thread] = await db
      .select({ providerThreadId: schema.threads.providerThreadId })
      .from(schema.threads)
      .where(eq(schema.threads.id, inbound.threadId));
    expect(thread?.providerThreadId).toMatch(/^\d+$/);

    await service?.supervisor.connection(mailboxId)?.syncFolder(pathOf("sent"));
    const sentCopies = (await stored(db, mailboxId, pathOf("sent"))).filter((r) =>
      r.subject?.endsWith(subject),
    );
    expect(sentCopies).toHaveLength(2);

    const position = await getFolderPosition(db, mailboxId, "INBOX");
    const archive = await enqueue(db, seeded, {
      kind: "archive",
      idempotencyKey: `gmail-archive-${mailboxId}`,
      payload: {
        folder: "INBOX",
        uidValidity: String(position?.uidvalidity),
        uids: [inbound.uid],
      },
    });
    await ping();
    await waitFor(async () => (await actionRow(db, archive.id)).status === "done", 60_000);
    expect((await stored(db, mailboxId, "INBOX")).some((r) => r.subject === subject)).toBe(false);
    await service?.supervisor.connection(mailboxId)?.syncFolder(pathOf("archive"));
    expect(
      (await stored(db, mailboxId, pathOf("archive"))).some(
        (r) => r.messageId === inbound.messageId,
      ),
    ).toBe(true);
  });

  it("puts the mailbox in error when Google refuses the refresh token", async () => {
    const seeded = await seedGoogle(`1//revoked-${randomUUID()}`);
    await start();
    await waitFor(async () => (await mailboxStatus(db, seeded.box.id)) === "error", 30_000);
    expect(service?.supervisor.connection(seeded.box.id)?.connected).toBe(false);
  });
});
