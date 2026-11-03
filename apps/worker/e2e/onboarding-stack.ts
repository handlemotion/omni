// The onboarding stack for e2e suites: a migrated database, the real Worker under workerd, the
// real mail service in-process (no Purelymail token, as a self-hoster runs it) on GreenMail, the
// local S3 gateway, and the local authoritative DNS server (`dns-server.ts`) that the mail
// service's resolver finds through NS records. Plus the calls the web app makes.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { parseKeyring } from "@omni/crypto";
import { createOrgWithOwner, schema } from "@omni/db";
import { createLogger, type MailService, sealCredentials, startService } from "@omni/mail";
import { expect } from "vitest";
import { startDnsServer, type DnsServer } from "./dns-server.ts";
import {
  authPost,
  CookieJar,
  createOrg,
  createTestDatabase,
  HMAC_SECRET,
  signIn,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

export const greenmail = {
  host: process.env.GREENMAIL_HOST ?? "localhost",
  imapPort: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
};

export function login(user: string, pass: string) {
  return {
    user,
    pass,
    imap: { host: greenmail.host, port: greenmail.imapPort, secure: false },
    smtp: { host: greenmail.host, port: greenmail.smtpPort, secure: false },
  };
}

export async function waitFor<T>(check: () => Promise<T | undefined | false>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export type OnboardingStack = Awaited<ReturnType<typeof startOnboardingStack>>;

export async function startOnboardingStack(options: { outboxIntervalMs?: number } = {}) {
  const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);
  const database = await createTestDatabase();
  const dns: DnsServer = await startDnsServer();
  // Auth and notification mail goes out from this mailbox, which the service connects too.
  const system = await createOrg(database.db, "system");
  const systemId = randomUUID();
  await database.db.insert(schema.mailboxes).values({
    id: systemId,
    orgId: system.id,
    address: SYSTEM_MAIL_FROM,
    kind: "shared",
    provider: "imap",
    credentialsEnc: await sealCredentials(keyring, systemId, login(SYSTEM_MAIL_FROM, "unused")),
  });

  // The Worker and the mail service each need the other's URL: listen first, attach the
  // service once the Worker is up.
  let handle: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const mailHttp = createServer((req, res) =>
    handle ? handle(req, res) : res.writeHead(503).end(),
  );
  await new Promise<void>((resolve) => mailHttp.listen(0, "127.0.0.1", resolve));
  const mailServiceUrl = `http://127.0.0.1:${(mailHttp.address() as AddressInfo).port}`;
  const worker = await startWorker({ databaseUrl: database.url, mailServiceUrl });
  const service: MailService = await startService(
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
      OUTBOX_INTERVAL_MS: options.outboxIntervalMs ?? 60 * 60_000,
      MAILBOX_CONCURRENCY: 4,
      // NS discovery and the nameservers themselves are the local DNS server.
      DNS_RESOLVERS: [dns.address],
      DNS_NAMESERVER_PORT: dns.port,
      DNS_TIMEOUT_MS: 1_000,
    },
    createLogger(process.env.E2E_LOG_LEVEL === "debug" ? "debug" : "error"),
  );
  handle = getRequestListener(service.app.fetch);

  /** A same-origin JSON call from the web app. */
  async function api(jar: CookieJar, method: "GET" | "POST", path: string, body?: unknown) {
    const headers = { cookie: jar.header, origin: WEB_ORIGIN, "content-type": "application/json" };
    const response = await fetch(
      new URL(`/api${path}`, worker.url),
      method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** An owner of an existing workspace, signed in (the default policy lets owners make more). */
  async function signedInOwner() {
    const slug = `home-${randomUUID().slice(0, 8)}`;
    const owner = await createOrgWithOwner(database.db, {
      name: slug,
      slug,
      ownerEmail: `owner@${slug}.test`,
    });
    const jar = new CookieJar();
    await signIn(worker, database.db, `owner@${slug}.test`, jar);
    return { ...owner, email: `owner@${slug}.test`, jar };
  }

  /** Publishes a claim's challenge at the domain's DNS host, the way the member copies it there. */
  function publishChallenge(body: Record<string, unknown>) {
    const challenge = body.challenge as { name: string; value: string };
    dns.set(challenge.name, "TXT", [challenge.value]);
  }

  /** A new workspace (its owner also owns a first one) with a domain claimed but not verified. */
  async function workspaceWithClaim() {
    const owner = await signedInOwner();
    const suffix = randomUUID().slice(0, 8);
    const created = await authPost(worker, owner.jar, "/organization/create", {
      name: "Acme",
      slug: `acme-${suffix}`,
    });
    expect(created.status).toBe(200);
    const orgId = ((await created.json()) as { id: string }).id;
    const domain = `acme-${suffix}.test`;
    dns.addZone(domain);
    // Typed the way people paste it; stored the one way every spelling normalizes to.
    const added = await api(owner.jar, "POST", "/onboarding/domains", {
      domain: `https://ACME-${suffix}.test/`,
    });
    expect(added).toMatchObject({
      status: 200,
      body: {
        domain,
        provider: "imap",
        status: "pending",
        added: false,
        verified: false,
        challenge: {
          type: "TXT",
          name: `_omni-challenge.${domain}`,
          value: expect.stringMatching(/^omni-challenge=/),
          verified: false,
        },
      },
    });
    return {
      ...owner,
      /** The owner's first workspace; `orgId` is the new one, which is now active. */
      homeOrgId: owner.orgId,
      orgId,
      domain,
      domainId: added.body.id as string,
      claim: added.body,
    };
  }

  /** A new workspace with its domain verified on the mail host, as the first two steps leave it. */
  async function workspaceWithDomain() {
    const workspace = await workspaceWithClaim();
    publishChallenge(workspace.claim);
    const checked = await api(
      workspace.jar,
      "POST",
      `/onboarding/domains/${workspace.domainId}/check`,
    );
    expect(checked).toMatchObject({
      status: 200,
      body: {
        id: workspace.domainId,
        status: "verified",
        added: true,
        verified: true,
        records: [],
      },
    });
    return workspace;
  }

  return {
    database,
    worker,
    service,
    dns,
    keyring,
    mailServiceUrl,
    api,
    signedInOwner,
    publishChallenge,
    workspaceWithClaim,
    workspaceWithDomain,
    async stop() {
      await new Promise((resolve) => mailHttp.close(resolve));
      await service.stop();
      await worker.server.close();
      await dns.close();
      await database.teardown();
    },
  };
}
