// E2E support: a throwaway migrated database per file, the real Worker under workerd via
// wrangler's test harness, and a real HTTP endpoint standing where the mail service listens.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { verifyRequest, type VerifyResult } from "@omni/crypto";
import { createDb, schema } from "@omni/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createTestHarness } from "wrangler";

export const HMAC_SECRET = "e2e-hmac-secret-e2e-hmac-secret-e2e-hmac";
export const SYSTEM_MAIL_FROM = "no-reply@omni.test";
/** The web app's origin; browsers send it on every auth POST. */
export const WEB_ORIGIN = "http://localhost:5173";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsFolder = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

function adminUrl() {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL is not set; run `pnpm stack:up` and set it (see .dev.vars.example)",
    );
  return url;
}

/** A migrated database for one test file. */
export async function createTestDatabase() {
  const name = `omni_e2e_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const { db, close } = createDb(url.toString(), { onnotice: () => {} });
  await migrate(db, { migrationsFolder });
  return {
    db,
    url: url.toString(),
    teardown: async () => {
      await close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDatabase>>["db"];

/** Records every request and checks its signature with the real verifier from `@omni/crypto`. */
export async function startMailServiceEndpoint() {
  const requests: { method: string; path: string; body: string; verified: VerifyResult }[] = [];
  const waiters: (() => void)[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const path = req.url ?? "/";
    const verified = await verifyRequest({
      secret: HMAC_SECRET,
      method: req.method ?? "GET",
      path,
      body,
      headers,
    });
    requests.push({ method: req.method ?? "GET", path, body, verified });
    res.writeHead(verified.ok ? 202 : 401).end();
    waiters.splice(0).forEach((wake) => wake());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Resolves once at least `count` requests have arrived. */
    async waitFor(count: number, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count) {
        if (Date.now() > deadline)
          throw new Error(`expected ${count} requests, got ${requests.length}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
      return requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The real Worker, bound to `databaseUrl` through Hyperdrive's local connection string. */
export async function startWorker(options: {
  databaseUrl: string;
  mailServiceUrl: string;
  vars?: Record<string, string>;
}) {
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = options.databaseUrl;
  const server = createTestHarness({
    root,
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          BETTER_AUTH_URL: "http://localhost:8787",
          AUTH_TRUSTED_ORIGINS: WEB_ORIGIN,
          MAIL_SERVICE_URL: options.mailServiceUrl,
          SYSTEM_MAIL_FROM,
          SENTRY_DSN: "",
          ...options.vars,
        },
        secrets: {
          BETTER_AUTH_SECRET: "e2e-auth-secret-e2e-auth-secret-e2e-auth",
          MAIL_SERVICE_HMAC_SECRET: HMAC_SECRET,
        },
      },
    ],
  });
  const { url } = await server.listen();
  return { server, url };
}

export async function createOrg(db: TestDb, slug: string) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      id: randomUUID(),
      name: slug,
      slug: `${slug}-${randomUUID()}`,
      createdAt: new Date(),
    })
    .returning();
  return org!;
}

export async function createMember(db: TestDb, orgId: string, email: string) {
  const [user] = await db
    .insert(schema.users)
    .values({ id: randomUUID(), name: email, email })
    .returning();
  const [member] = await db
    .insert(schema.members)
    .values({ id: randomUUID(), organizationId: orgId, userId: user!.id, createdAt: new Date() })
    .returning();
  return member!;
}

export async function createMailbox(
  db: TestDb,
  orgId: string,
  address: string,
  kind: "personal" | "shared" = "shared",
) {
  const [mailbox] = await db
    .insert(schema.mailboxes)
    .values({ orgId, address, kind, credentialsEnc: "not-a-real-ciphertext", status: "active" })
    .returning();
  return mailbox!;
}

export async function grant(db: TestDb, orgId: string, mailboxId: string, memberId: string) {
  await db.insert(schema.mailboxAccess).values({ orgId, mailboxId, memberId });
}
