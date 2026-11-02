// E2E support: a throwaway migrated database per file, the real Worker under workerd via
// wrangler's test harness, and a real HTTP endpoint standing where the mail service listens.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { signRequest, verifyRequest, type VerifyResult } from "@omni/crypto";
import { addLocation, createDb, createThread, schema, upsertFolder, upsertMessage } from "@omni/db";
import { MAIL_EVENTS_PATH, type MailEventsBody } from "@omni/contracts";
import { desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createTestHarness, unstable_startWorker } from "wrangler";

export const HMAC_SECRET = "e2e-hmac-secret-e2e-hmac-secret-e2e-hmac";
export const SYSTEM_MAIL_FROM = "no-reply@omni.test";
/** The web app's origin; browsers send it on every auth POST. */
export const WEB_ORIGIN = "http://localhost:5173";

const root = join(import.meta.dirname, "..");
const migrationsFolder = join(import.meta.dirname, "../../../packages/db/migrations");

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
interface WorkerOptions {
  databaseUrl: string;
  mailServiceUrl: string;
  vars?: Record<string, string>;
}

function workerVars(options: WorkerOptions) {
  return {
    BETTER_AUTH_URL: "http://localhost:8787",
    AUTH_TRUSTED_ORIGINS: WEB_ORIGIN,
    MAIL_SERVICE_URL: options.mailServiceUrl,
    SYSTEM_MAIL_FROM,
    SENTRY_DSN: "",
    ENVIRONMENT: "test",
    ...options.vars,
  };
}

const workerSecrets = {
  BETTER_AUTH_SECRET: "e2e-auth-secret-e2e-auth-secret-e2e-auth",
  MAIL_SERVICE_HMAC_SECRET: HMAC_SECRET,
  // No external AI provider in e2e: only the rule path runs.
  ANTHROPIC_API_KEY: "",
  TYPESAFE_API_KEY: "",
};

/** The real Worker, bound to `databaseUrl` through Hyperdrive's local connection string. */
export async function startWorker(options: WorkerOptions) {
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = options.databaseUrl;
  const server = createTestHarness({
    root,
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: workerVars(options),
        secrets: workerSecrets,
      },
    ],
  });
  const { url } = await server.listen();
  return { server, url };
}

/**
 * The Worker under `wrangler dev`'s own runtime, whose outbound fetch is workerd's network
 * stack. The test harness routes outbound fetch through Node's `fetch`, which follows redirects
 * even under `redirect: "manual"`; suites that check redirect handling need the real behavior.
 */
export async function startWorkerWithNetwork(options: WorkerOptions) {
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = options.databaseUrl;
  const worker = await unstable_startWorker({
    config: join(import.meta.dirname, "../wrangler.jsonc"),
    bindings: Object.fromEntries([
      ...Object.entries(workerVars(options)).map(([k, value]) => [
        k,
        { type: "plain_text" as const, value },
      ]),
      ...Object.entries(workerSecrets).map(([k, value]) => [
        k,
        { type: "secret_text" as const, value },
      ]),
    ]),
    dev: {
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      persist: false,
      watch: false,
      logLevel: "none",
    },
  });
  await worker.ready;
  return { url: await worker.url, close: () => worker.dispose() };
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

type Worker = { url: string | URL };
type Harnessed = Awaited<ReturnType<typeof startWorker>>;

/** One browser's cookies: what it sends, updated from every `Set-Cookie` it gets back. */
export class CookieJar {
  readonly cookies = new Map<string, string>();

  store(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      const value = pair!.slice(at + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  get header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/** A same-origin auth call from the web app, carrying and updating the jar. */
export async function authPost(worker: Worker, jar: CookieJar, path: string, body: unknown) {
  return jar.store(
    await fetch(new URL(`/api/auth${path}`, worker.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie: jar.header },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * The real magic-link flow: request a link, read it from the outbox, open it. Returns the cookie.
 * With `jar`, the link is opened in that browser (so its other sessions stay signed in).
 */
export async function signIn(worker: Worker, db: TestDb, email: string, jar?: CookieJar) {
  const requested = await fetch(new URL("/api/auth/sign-in/magic-link", worker.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  if (requested.status !== 200) throw new Error(`magic link request failed: ${requested.status}`);
  const rows = await db
    .select({ payload: schema.mailActions.payload })
    .from(schema.mailActions)
    .where(eq(schema.mailActions.kind, "send"))
    .orderBy(desc(schema.mailActions.createdAt));
  const link = rows
    .map((row) => row.payload as { to?: string[]; text?: string })
    .find((p) => p.to?.[0] === email)
    ?.text?.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`no magic link for ${email} in the outbox`);
  const url = new URL(link);
  const verified = await fetch(new URL(url.pathname + url.search, worker.url), {
    redirect: "manual",
    headers: jar ? { cookie: jar.header } : {},
  });
  jar?.store(verified);
  return verified.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** One message in an IMAP folder, threaded on its own, the way the mail service stores it. */
export async function seedMessage(
  db: TestDb,
  mailbox: { id: string; orgId: string },
  message: {
    subject: string;
    fromAddress: string;
    to?: string[];
    folder?: string;
    uid: number;
    messageId?: string;
    threadId?: string;
    sentAt?: Date;
    text?: string;
  },
) {
  const folderPath = message.folder ?? "INBOX";
  const folder = await upsertFolder(db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    path: folderPath,
    role: folderPath === "INBOX" ? "inbox" : folderPath === "Sent" ? "sent" : "other",
    uidvalidity: 1_700_000_000,
    uidnext: 1000,
    highestModseq: null,
  });
  const sentAt = message.sentAt ?? new Date();
  const threadId =
    message.threadId ??
    (await createThread(db, {
      orgId: mailbox.orgId,
      mailboxId: mailbox.id,
      subjectKey: message.subject.toLowerCase(),
      lastMessageAt: sentAt,
    }));
  const stored = await upsertMessage(db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    threadId,
    folderId: folder.id,
    imapUid: message.uid,
    messageIdHeader: message.messageId ?? `<${randomUUID()}@omni.test>`,
    subject: message.subject,
    fromAddress: message.fromAddress,
    to: (message.to ?? []).map((address) => ({ name: null, address })),
    sentAt,
    cleanText: message.text ?? message.subject,
  });
  // Where the copy lives on the server, as the mail service records it.
  await addLocation(db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    folderId: folder.id,
    uid: message.uid,
    messageId: stored.id,
    flags: [],
    modseq: null,
  });
  return { threadId, messageId: stored.id, folder };
}

/** Calls `/internal/mail-events` the way the mail service does: signed, with a fresh nonce. */
export async function postMailEvents(
  worker: Worker,
  body: MailEventsBody | string,
  sign: { secret?: string; timestamp?: number; nonce?: string | null } = {},
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = await signRequest({
    secret: sign.secret ?? HMAC_SECRET,
    method: "POST",
    path: MAIL_EVENTS_PATH,
    body: text,
    timestamp: sign.timestamp,
    nonce: sign.nonce === null ? undefined : (sign.nonce ?? randomUUID().replaceAll("-", "")),
  });
  return fetch(new URL(MAIL_EVENTS_PATH, worker.url), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: text,
  });
}

/** Parsed JSON log lines (`console.log(JSON.stringify(...))`) the Worker wrote so far. */
export function workerEvents(worker: Harnessed) {
  return worker.server.getLogs().flatMap((log) => {
    try {
      return [JSON.parse(log.message) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/** Waits until the Worker has logged `count` events matching `match`. */
export async function waitForEvents(
  worker: Harnessed,
  match: (event: Record<string, unknown>) => boolean,
  count = 1,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = workerEvents(worker).filter(match);
    if (found.length >= count) return found;
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} matching Worker events, saw ${found.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
