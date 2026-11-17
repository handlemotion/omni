// Omni-hosted mail against Purelymail itself (ADR 0007). GreenMail cannot be Purelymail's API, so
// this runs only when asked for, never in `pnpm test` or CI. It uses the production Purelymail
// account, confined to a test domain that is on the account already (its records are in DNS):
//
//   doppler run -p omni -c prd_mail --only-secrets PURELYMAIL_API_TOKEN -- \
//     env PURELYMAIL_E2E=1 PURELYMAIL_E2E_DOMAIN=e2e.omnidirectional.app \
//     DATABASE_URL=postgres://postgres:postgres@localhost:54329/omni \
//     pnpm --filter @omni/mail test:e2e purelymail-live
//
// Every user it creates is named `omnie2e<random>` and deleted at the end, with its app passwords.
// It sends one message from a test user to itself.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  HOSTED_DISCONNECT_PATH,
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
  async function call<T>(path: string, body: unknown) {
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
    return { status: response.status, json: (await response.json()) as T } satisfies {
      status: number;
      json: T;
    };
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

  /** The org that holds the test domain as Purelymail accepted it, as after onboarding. */
  let claimed: Awaited<ReturnType<typeof seedOwner>> | undefined;
  async function claimTestDomain() {
    if (claimed) return claimed;
    const owner = await seedOwner(db);
    await db.insert(schema.mailDomains).values({
      orgId: owner.orgId,
      domain,
      provider: "purelymail",
      addedAt: new Date(),
    });
    claimed = owner;
    return owner;
  }

  /**
   * A fresh test user's address. Letters and digits only: with symbolic subaddressing on (the
   * default for a new Purelymail domain) a name with `-`, `.`, `_` or `+` is refused.
   */
  function testAddress() {
    return `omnie2e${randomBytes(4).toString("hex")}@${domain}`;
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

  it("reports the account's credit state in /health", async () => {
    // "unknown" means the credit call or its parsing failed; the real account is "ok" or "low".
    const health = await waitFor(async () => {
      const json = (await (await fetch(`${serviceUrl}/health`)).json()) as Record<string, unknown>;
      return json.hostCredit === "unknown" ? undefined : json;
    }, 30_000);
    expect(["ok", "low"]).toContain(health.hostCredit);
  });

  it("creates a hosted mailbox that syncs and sends, and never issues a second login", async () => {
    const owner = await claimTestDomain();
    const address = testAddress();
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
  }, 240_000);

  // The test domain keeps Purelymail's default (symbolic subaddressing on), like any domain that
  // was on the account before Omni turned it off for domains it adds.
  it("refuses a name with a symbol on such a domain, with a reason and no user created", async () => {
    const owner = await claimTestDomain();
    const address = `omnie2e.${randomBytes(4).toString("hex")}@${domain}`;
    const refused = await call<{ error: string }>(PROVISION_MAILBOX_PATH, {
      orgId: owner.orgId,
      address,
      kind: "shared",
      ownerMemberId: owner.memberId,
      login: { provider: "purelymail" },
    });
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatch(/Use only letters and digits/);
    expect(await purelymail.listUsers()).not.toContain(address);
  });

  it("disconnects a hosted mailbox: its app password is revoked, the user and mail stay", async () => {
    const owner = await claimTestDomain();
    const address = testAddress();
    created.push(address);
    const { json } = await call<ProvisionMailboxResult>(PROVISION_MAILBOX_PATH, {
      orgId: owner.orgId,
      address,
      kind: "shared",
      ownerMemberId: owner.memberId,
      login: { provider: "purelymail" },
    });
    const { pass } = await loginOf(json.mailboxId);

    const gone = await call<{ mailboxId: string }>(HOSTED_DISCONNECT_PATH, {
      orgId: owner.orgId,
      mailboxId: json.mailboxId,
    });
    expect(gone).toMatchObject({ status: 200, json: { mailboxId: json.mailboxId } });
    expect(await mailboxStatus(db, json.mailboxId)).toBeUndefined();
    // Purelymail refuses to delete an app password it no longer has.
    await expect(purelymail.deleteAppPassword(address, pass)).rejects.toThrow(
      /deleteAppPassword failed/,
    );
    expect(await purelymail.listUsers()).toContain(address);
  }, 120_000);

  /** A new hosted mailbox on the test domain, synced and active. */
  async function activeHostedMailbox() {
    const owner = await claimTestDomain();
    const address = testAddress();
    created.push(address);
    const { json } = await call<ProvisionMailboxResult>(PROVISION_MAILBOX_PATH, {
      orgId: owner.orgId,
      address,
      kind: "shared",
      ownerMemberId: owner.memberId,
      login: { provider: "purelymail" },
    });
    await waitFor(async () => (await mailboxStatus(db, json.mailboxId)) === "active", 60_000);
    return { address, mailboxId: json.mailboxId };
  }

  /** Drops the connection and lets the service connect again from the stored login. */
  async function reconnect(mailboxId: string) {
    await service.supervisor.remove(mailboxId);
    await service.reconcileMailboxes();
  }

  it("heals a hosted mailbox whose app password was revoked with a new one", async () => {
    const { address, mailboxId } = await activeHostedMailbox();
    const revoked = (await loginOf(mailboxId)).pass;
    await purelymail.deleteAppPassword(address, revoked);

    await reconnect(mailboxId);
    // The login fails, Omni mints a new app password, stores it and reconnects with it.
    await waitFor(async () => (await loginOf(mailboxId)).pass !== revoked, 60_000);
    await waitFor(async () => (await mailboxStatus(db, mailboxId)) === "active", 60_000);
    expect(service.supervisor.connection(mailboxId)?.connected).toBe(true);
  }, 240_000);

  it("leaves a hosted mailbox in error when its user was deleted at Purelymail", async () => {
    const { address, mailboxId } = await activeHostedMailbox();
    await purelymail.deleteUser(address);

    await reconnect(mailboxId);
    await waitFor(async () => (await mailboxStatus(db, mailboxId)) === "error", 60_000);
    // Healing replaces a lost password, never a mailbox someone deleted on purpose.
    expect(await purelymail.listUsers()).not.toContain(address);
  }, 240_000);
});
