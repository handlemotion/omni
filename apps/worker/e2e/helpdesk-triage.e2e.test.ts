import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { serve } from "@hono/node-server";
import { parseKeyring } from "@omni/crypto";
import { schema } from "@omni/db";
import { createLogger, sealCredentials, startService, type MailService } from "@omni/mail";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  HMAC_SECRET,
  signIn,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

const fixtures = new URL("../../../fixtures/", import.meta.url);
const greenmail = {
  host: process.env.GREENMAIL_HOST ?? "localhost",
  imapPort: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
};
const keyring = parseKeyring(`k1:${randomBytes(32).toString("base64")}`);
const manifest = JSON.parse(readFileSync(new URL("triage/helpdesk.json", fixtures), "utf8")) as {
  tags: Array<{ name: string; description?: string }>;
  teammates: Array<{ key: string; role: string }>;
};

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let jev: Awaited<ReturnType<typeof startJevReplay>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mail: { service: MailService; http: ReturnType<typeof serve> };

async function startJevReplay() {
  const dir = new URL("triage/recordings/", fixtures);
  const recordings = readdirSync(dir)
    .filter((file) => file.startsWith("helpdesk-"))
    .map((file) => ({
      id: file.replace(/\.json$/, ""),
      ...(JSON.parse(readFileSync(new URL(file, dir), "utf8")) as {
        request: unknown;
        response: unknown;
      }),
    }));
  const hits: string[] = [];
  const unmatched: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "null");
    const found =
      req.url === "/v1/systemone" &&
      req.headers.authorization === "Bearer recorded" &&
      recordings.find((r) => isDeepStrictEqual(r.request, body));
    if (!found) {
      unmatched.push(body);
      res.writeHead(500).end("no recording for this request");
      return;
    }
    hits.push(found.id);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(found.response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    unmatched,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  database = await createTestDatabase();
  jev = await startJevReplay();
  const mailPort = await freePort();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: `http://127.0.0.1:${mailPort}`,
    vars: { TYPESAFE_API_URL: jev.url },
    secrets: { TYPESAFE_API_KEY: "recorded" },
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
      SYNC_INTERVAL_MS: 500,
      OUTBOX_INTERVAL_MS: 500,
      MAILBOX_CONCURRENCY: 2,
    },
    createLogger("error"),
  );
  const http = serve({ fetch: service.app.fetch, port: mailPort, hostname: "127.0.0.1" });
  mail = { service, http };

  const system = await createOrg(database.db, "system");
  const systemBox = await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
  await database.db
    .update(schema.mailboxes)
    .set({ status: "disabled" })
    .where(eq(schema.mailboxes.id, systemBox.id));
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => (mail?.http ? mail.http.close(resolve) : resolve(undefined)));
  await mail?.service.stop();
  await worker?.server.close();
  await jev?.close();
  await database?.teardown();
});

async function waitUntil<T>(check: () => Promise<T | false | undefined>, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out; Jev requests with no recording: ${jev.unmatched.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function call(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api${path}`, worker.url), {
    method,
    headers: {
      cookie,
      origin: WEB_ORIGIN,
      "content-type": "application/json",
      "idempotency-key": `helpdesk-${randomUUID()}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Answer };
}

interface Answer {
  roleDescription: string | null;
  tag: { id: string; description: string | null };
  members: { id: string; roleDescription: string | null }[];
  sharedInboxes: unknown[];
}

async function customerSends(name: string, inbox: string) {
  const raw = readFileSync(new URL(`eml/${name}`, fixtures), "utf8");
  const from = raw.match(/^Return-Path: <(.+)>$/m)![1]!;
  const transport = createTransport({
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  try {
    await transport.sendMail({ envelope: { from, to: [inbox] }, raw });
  } finally {
    transport.close();
  }
  return raw.match(/^Message-ID: *(.+)$/im)![1]!.trim();
}

async function folderSubjects(user: string, path: string) {
  const client = new ImapFlow({
    host: greenmail.host,
    port: greenmail.imapPort,
    secure: false,
    auth: { user, pass: "unused" },
    logger: false,
  });
  await client.connect();
  try {
    if (!(await client.list()).some((folder) => folder.path === path)) return [];
    const lock = await client.getMailboxLock(path);
    try {
      const subjects: string[] = [];
      for await (const message of client.fetch("1:*", { envelope: true })) {
        subjects.push(message.envelope?.subject ?? "");
      }
      return subjects;
    } catch {
      return [];
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function setUpSupport() {
  const { db } = database;
  const inbox = `support-${randomUUID().slice(0, 8)}@helpdesk.test`;
  const org = await createOrg(db, "lumen");
  const owner = await createMember(db, org.id, `owner-${randomUUID().slice(0, 8)}@lumen.test`);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, owner.id));
  const id = randomUUID();
  await db.insert(schema.mailboxes).values({
    id,
    orgId: org.id,
    address: inbox,
    kind: "shared",
    credentialsEnc: await sealCredentials(keyring, id, {
      user: inbox,
      pass: "unused",
      imap: { host: greenmail.host, port: greenmail.imapPort, secure: false },
      smtp: { host: greenmail.host, port: greenmail.smtpPort, secure: false },
    }),
  });
  await grant(db, org.id, id, owner.id);
  const team: Record<string, string> = {};
  for (const { key } of manifest.teammates) {
    const member = await createMember(db, org.id, `${key}-${randomUUID().slice(0, 8)}@lumen.test`);
    await grant(db, org.id, id, member.id);
    team[key] = member.id;
  }
  await mail.service.reconcileMailboxes();
  await waitUntil(async () => {
    const [row] = await db
      .select({ status: schema.mailboxes.status })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, id));
    return row?.status === "active";
  });
  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, owner.userId));
  const cookie = await signIn(worker, db, user!.email);

  for (const { key, role } of manifest.teammates) {
    const set = await call(cookie, "PUT", `/workspace/ai/members/${team[key]}/role`, {
      description: role,
    });
    expect(set).toMatchObject({ status: 200, body: { roleDescription: role } });
  }
  const tagIds: Record<string, string> = {};
  for (const tag of manifest.tags) {
    const created = await call(cookie, "POST", `/mailboxes/${id}/tags`, { name: tag.name });
    expect(created.status).toBeLessThan(300);
    tagIds[tag.name] = created.body.tag.id;
    const described = await call(cookie, "PATCH", `/mailboxes/${id}/tags/${created.body.tag.id}`, {
      description: tag.description ?? "",
    });
    expect(described).toMatchObject({
      status: 200,
      body: { tag: { description: tag.description ?? null } },
    });
  }
  return { inbox, mailboxId: id, orgId: org.id, ownerId: owner.id, cookie, team, tagIds };
}

async function threadOf(messageIdHeader: string) {
  return waitUntil(async () => {
    const [row] = await database.db
      .select({ threadId: schema.messages.threadId, id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.messageIdHeader, messageIdHeader));
    return row;
  });
}

async function triagedFor(threadId: string, messageId: string) {
  await waitUntil(async () => {
    const [row] = await database.db
      .select({ done: schema.threads.summaryMessageId })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    return row?.done === messageId;
  });
}

async function conversation(cookie: string, threadId: string) {
  const response = await call(cookie, "GET", `/threads/${threadId}/conversation`);
  expect(response.status).toBe(200);
  return response.body as unknown as {
    status: string;
    priority: string;
    assigneeMemberId: string | null;
    tags: { id: string; name: string }[];
    events: { kind: string; actorMemberId: string | null; data: Record<string, unknown> }[];
  };
}

test("the settings page lists each teammate's role and each shared inbox's tags", async () => {
  const support = await setUpSupport();
  const page = await call(support.cookie, "GET", "/workspace/ai");
  expect(page.status).toBe(200);
  const ana = page.body.members.find((m: { id: string }) => m.id === support.team.ana);
  expect(ana).toMatchObject({ roleDescription: manifest.teammates[0]!.role });
  const owner = page.body.members.find((m: { id: string }) => m.id === support.ownerId);
  expect(owner).toMatchObject({ roleDescription: null });
  expect(page.body.sharedInboxes).toEqual([
    {
      id: support.mailboxId,
      address: support.inbox,
      tags: manifest.tags.map((tag) => ({
        id: support.tagIds[tag.name],
        name: tag.name,
        color: null,
        description: tag.description ?? null,
      })),
    },
  ]);

  const cleared = await call(
    support.cookie,
    "PUT",
    `/workspace/ai/members/${support.team.cy}/role`,
    {
      description: "  ",
    },
  );
  expect(cleared).toMatchObject({ status: 200, body: { roleDescription: null } });
  const other = await createMember(
    database.db,
    (await createOrg(database.db, "other")).id,
    `x-${randomUUID().slice(0, 8)}@other.test`,
  );
  const foreign = await call(support.cookie, "PUT", `/workspace/ai/members/${other.id}/role`, {
    description: "Anything",
  });
  expect(foreign.status).toBe(404);
});

test("a customer's double charge is triaged high, tagged Billing and handed to billing; a person's changes hold", async () => {
  const support = await setUpSupport();

  const first = await threadOf(await customerSends("helpdesk-double-charge.eml", support.inbox));
  await triagedFor(first.threadId, first.id);
  const triaged = await conversation(support.cookie, first.threadId);
  expect(triaged).toMatchObject({
    status: "open",
    priority: "high",
    assigneeMemberId: support.team.ana,
    tags: [{ id: support.tagIds.Billing, name: "Billing" }],
  });
  const aiEvents = triaged.events.filter((e) => e.data.source === "ai");
  expect(aiEvents.map((e) => e.kind).sort()).toEqual(["assigned", "priority", "tag_added"]);
  expect(aiEvents.every((e) => e.actorMemberId === null)).toBe(true);
  const notified = await database.db
    .select({ kind: schema.notifications.kind })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.memberId, support.team.ana!),
        eq(schema.notifications.threadId, first.threadId),
      ),
    );
  expect(notified).toEqual([{ kind: "assigned" }]);

  const { cookie } = support;
  expect(
    (await call(cookie, "PUT", `/threads/${first.threadId}/priority`, { priority: "normal" }))
      .status,
  ).toBe(200);
  expect(
    (await call(cookie, "DELETE", `/threads/${first.threadId}/tags/${support.tagIds.Billing}`))
      .status,
  ).toBe(200);
  expect(
    (await call(cookie, "PUT", `/threads/${first.threadId}/assignee`, { memberId: null })).status,
  ).toBe(200);

  const second = await threadOf(
    await customerSends("helpdesk-double-charge-again.eml", support.inbox),
  );
  expect(second.threadId).toBe(first.threadId);
  await triagedFor(first.threadId, second.id);
  expect(jev.hits).toContain("helpdesk-double-charge-2");
  expect(await conversation(cookie, first.threadId)).toMatchObject({
    status: "open",
    priority: "normal",
    assigneeMemberId: null,
    tags: [],
  });
});

test("a newsletter to the support inbox is resolved as noise and archived out of INBOX", async () => {
  const support = await setUpSupport();
  const promo = await threadOf(await customerSends("helpdesk-promo.eml", support.inbox));
  await triagedFor(promo.threadId, promo.id);
  const filed = await conversation(support.cookie, promo.threadId);
  expect(filed).toMatchObject({
    status: "resolved",
    priority: "low",
    assigneeMemberId: null,
    tags: [],
  });
  expect(filed.events).toContainEqual(
    expect.objectContaining({
      kind: "status",
      actorMemberId: null,
      data: expect.objectContaining({ to: "resolved", reason: "ai_noise" }),
    }),
  );
  const subject = "5 tactics to triple your newsletter signups this week";
  await waitUntil(
    async () => !(await folderSubjects(support.inbox, "INBOX")).includes(subject),
    30_000,
  );
});
