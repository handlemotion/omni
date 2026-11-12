// A Google account against Gmail itself (ADR 0023). GreenMail cannot be Gmail, so this runs only
// when asked for, against a dedicated test account, never in `pnpm test` or CI:
//
//   doppler run -p omni -c dev_mail -- env GMAIL_E2E=1 pnpm --filter @omni/mail test:e2e google-live
//
// It needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the OAuth client), GMAIL_E2E_ADDRESS (the
// test account) and GMAIL_E2E_REFRESH_TOKEN (its grant: `google:connect --pipe-refresh-token |
// doppler secrets set GMAIL_E2E_REFRESH_TOKEN -p omni -c dev_mail`). It sends mail from the test account to itself.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAIL_PING_PATH } from "@omni/contracts";
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
    // Accepts the service's mail events; what they say is covered by service.e2e.test.ts.
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

  /** A mailbox row for the test account holding only its refresh token, as after a restart. */
  async function seedGoogle(token: string) {
    // Each test gets its own org, so the same address can be seeded twice.
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
    // Gmail delivers it back to the inbox; IDLE picks it up.
    const arrived = await waitFor(
      async () => (await stored(db, seeded.box.id, "INBOX")).find((r) => r.subject === subject),
      60_000,
    );
    expect(arrived.cleanText).toContain("to myself, through Gmail");
  });

  it("puts the mailbox in error when Google refuses the refresh token", async () => {
    const seeded = await seedGoogle(`1//revoked-${randomUUID()}`);
    await start();
    await waitFor(async () => (await mailboxStatus(db, seeded.box.id)) === "error", 30_000);
    // Retrying cannot fix a revoked grant: the connection stops instead of hammering Google.
    expect(service?.supervisor.connection(seeded.box.id)?.connected).toBe(false);
  });
});
