// Omni-hosted mail against Purelymail itself (ADR 0007). GreenMail cannot be Purelymail's API, so
// this runs only when asked for, never in `pnpm test` or CI. It uses the production Purelymail
// account, confined to a test domain that is on the account already (its records are in DNS):
//
//   doppler run -p omni -c prd_mail --only-secrets PURELYMAIL_API_TOKEN -- \
//     env PURELYMAIL_E2E=1 PURELYMAIL_E2E_DOMAIN=e2e.omnidirectional.app \
//     DATABASE_URL=postgres://postgres:postgres@localhost:54329/omni \
//     pnpm --filter @omni/mail test:e2e purelymail-live
//
// Every user it creates is named `omni-e2e-<random>` and deleted at the end, with its app passwords.
// It sends one message from a test user to itself.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  MAIL_PING_PATH,
  PROVISION_DOMAIN_PATH,
  PROVISION_MAILBOX_PATH,
  type ProvisionDomainResult,
  type ProvisionMailboxResult,
} from "@omni/contracts";
import { parseKeyring, signRequest } from "@omni/crypto";
import { enqueueAction, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCredentials } from "../src/credentials.ts";
import { createPurelymailClient, type PurelymailClient } from "../src/providers/purelymail.ts";
import { type MailService, startService } from "../src/service.ts";
import {
  actionRow,
  createTestDatabase,
  mailboxStatus,
  seedOwner,
  stored,
  type TestDb,
} from "./support/db.ts";
import { logger, waitFor } from "./support/greenmail.ts";
import { createTestBucket } from "./support/objects.ts";

const requested = process.env.PURELYMAIL_E2E === "1";
const token = process.env.PURELYMAIL_API_TOKEN ?? "";
const domain = process.env.PURELYMAIL_E2E_DOMAIN ?? "";
const secret = randomBytes(32).toString("hex");
const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);

describe.runIf(requested)("Purelymail itself", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let db: TestDb;
  let bucket: Awaited<ReturnType<typeof createTestBucket>>;
  let worker: Server;
  let service: MailService;
  let http: ReturnType<typeof serve>;
  let serviceUrl = "";
  let purelymail: PurelymailClient;
  /** Users this run created, deleted in `afterAll` whatever happened. */
  const created: string[] = [];

  beforeAll(async () => {
    if (!token) throw new Error("PURELYMAIL_E2E=1 needs PURELYMAIL_API_TOKEN");
    if (!domain) throw new Error("PURELYMAIL_E2E=1 needs PURELYMAIL_E2E_DOMAIN");
    purelymail = createPurelymailClient(token);
    database = await createTestDatabase();
    db = database.db;
    bucket = await createTestBucket();
    // Accepts the service's mail events; what they say is covered by service.e2e.test.ts.
    worker = createServer((_req, res) => res.writeHead(202).end());
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
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
        PURELYMAIL_API_TOKEN: token,
      },
      logger,
    );
    http = serve({ fetch: service.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => http.once("listening", () => resolve()));
    serviceUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    http?.close();
    await service?.stop();
    // Users go even when a test failed, so a broken run leaves nothing on the account.
    for (const user of created) {
      await purelymail.deleteUser(user).catch((error: unknown) => {
        logger.error("e2e.cleanup_failed", { user, error });
      });
    }
    await new Promise((resolve) => worker?.close(resolve));
    await database?.teardown();
  });

  /** A signed Worker → mail service call, as `apps/worker/src/mail-service.ts` makes it. */
  async function call<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
    const text = JSON.stringify(body);
    const headers = await signRequest({
      secret,
      method: "POST",
      path,
      body: text,
      nonce: randomUUID().replaceAll("-", ""),
    });
    const response = await fetch(`${serviceUrl}${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: text,
    });
    return { status: response.status, json: (await response.json()) as T };
  }

  async function ping() {
    const headers = await signRequest({
      secret,
      method: "POST",
      path: MAIL_PING_PATH,
      nonce: randomUUID(),
    });
    await fetch(`${serviceUrl}${MAIL_PING_PATH}`, { method: "POST", headers });
  }

  /** An org that holds the test domain as Purelymail accepted it, as after onboarding. */
  async function claimTestDomain() {
    const owner = await seedOwner(db);
    await db.insert(schema.mailDomains).values({
      orgId: owner.orgId,
      domain,
      provider: "purelymail",
      addedAt: new Date(),
    });
    return owner;
  }

  /** The stored login of a mailbox, as only this service can read it. */
  async function loginOf(mailboxId: string) {
    const [row] = await db
      .select({ credentialsEnc: schema.mailboxes.credentialsEnc })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    const login = await openCredentials(keyring, mailboxId, row?.credentialsEnc ?? "");
    if ("oauth" in login) throw new Error("expected an app password");
    return login;
  }

  it("reads the test domain's records and checks from Purelymail", async () => {
    const { status, json } = await call<ProvisionDomainResult>(PROVISION_DOMAIN_PATH, {
      domain,
      add: false,
    });
    expect(status).toBe(200);
    if (json.provider !== "purelymail") throw new Error("expected the Purelymail answer");
    expect(json.added).toBe(true);
    expect(json.records.map((r) => r.check).toSorted()).toEqual(
      ["dkim", "dkim", "dkim", "dmarc", "mx", "ownership", "spf"].toSorted(),
    );
    // Purelymail's own DNS checks pass, so mail to and from the domain is real mail.
    expect(json.records.filter((r) => !r.verified)).toEqual([]);
  });

  it("creates a hosted mailbox that syncs and sends, and never issues a second login", async () => {
    const owner = await claimTestDomain();
    const address = `omni-e2e-${randomBytes(4).toString("hex")}@${domain}`;
    created.push(address);
    const body = {
      orgId: owner.orgId,
      address,
      kind: "shared",
      ownerMemberId: owner.memberId,
      login: { provider: "purelymail" },
    };

    const first = await call<ProvisionMailboxResult>(PROVISION_MAILBOX_PATH, body);
    expect(first).toMatchObject({ status: 200, json: { address, created: true } });
    const mailboxId = first.json.mailboxId;
    expect(await purelymail.listUsers()).toContain(address);
    await waitFor(async () => (await mailboxStatus(db, mailboxId)) === "active", 60_000);

    // A retried request returns the same mailbox with the same login.
    const login = await loginOf(mailboxId);
    const again = await call<ProvisionMailboxResult>(PROVISION_MAILBOX_PATH, body);
    expect(again).toMatchObject({ status: 200, json: { mailboxId, created: false } });
    expect((await loginOf(mailboxId)).pass).toBe(login.pass);

    // To itself through Purelymail's SMTP; IDLE brings it back into the inbox.
    const subject = `omni hosted e2e ${randomUUID()}`;
    const send = await enqueueAction(db, {
      orgId: owner.orgId,
      mailboxId,
      memberId: owner.memberId,
      kind: "send",
      idempotencyKey: `purelymail-live-${mailboxId}`,
      payload: { from: address, to: [address], subject, text: "to myself, on hosted mail" },
    });
    await ping();
    await waitFor(async () => (await actionRow(db, send.id)).status === "done", 60_000);
    const arrived = await waitFor(
      async () => (await stored(db, mailboxId, "INBOX")).find((r) => r.subject === subject),
      90_000,
    );
    expect(arrived.cleanText).toContain("to myself, on hosted mail");
  });

  it("puts a hosted mailbox in error once its app password is revoked", async () => {
    const owner = await claimTestDomain();
    const address = `omni-e2e-${randomBytes(4).toString("hex")}@${domain}`;
    created.push(address);
    const { json } = await call<ProvisionMailboxResult>(PROVISION_MAILBOX_PATH, {
      orgId: owner.orgId,
      address,
      kind: "shared",
      ownerMemberId: owner.memberId,
      login: { provider: "purelymail" },
    });
    const mailboxId = json.mailboxId;
    await waitFor(async () => (await mailboxStatus(db, mailboxId)) === "active", 60_000);

    await purelymail.deleteAppPassword(address, (await loginOf(mailboxId)).pass);
    // A reconnect logs in again with the revoked password; today nothing mints a new one.
    await service.supervisor.remove(mailboxId);
    await service.reconcileMailboxes();
    await waitFor(async () => (await mailboxStatus(db, mailboxId)) === "error", 60_000);
    expect(service.supervisor.connection(mailboxId)?.connected).toBe(false);
  });
});
