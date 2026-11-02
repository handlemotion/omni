// Long-run faults against the real stack: connections dropped, refused or gone silent between the
// service and GreenMail (through a real TCP relay), hostile mail mid-import, a send while the
// mailbox is offline, and the service process itself terminated and killed mid-import.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseKeyring } from "@omni/crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sealCredentials } from "../src/credentials.ts";
import { MailboxConnection } from "../src/mailbox-connection.ts";
import { deterministicMessageId, OutboxExecutor } from "../src/outbox.ts";
import { PgActionSource, PgMailStore } from "../src/pg-store.ts";
import {
  actionRow,
  createTestDatabase,
  enqueue,
  messageRows,
  seedMailbox,
  setCredentials,
  stored,
  type TestDb,
} from "./support/db.ts";
import { deliver, logger, mailbox, otherClient, waitFor } from "./support/greenmail.ts";
import { createTestBucket, links } from "./support/objects.ts";
import { type FaultyLink, faultyLink } from "./support/proxy.ts";

const greenmail = {
  host: process.env.GREENMAIL_HOST ?? "localhost",
  port: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
};

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let bucket: Awaited<ReturnType<typeof createTestBucket>>;
let store: PgMailStore;
let connections: MailboxConnection[] = [];
let relays: FaultyLink[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  bucket = await createTestBucket();
  store = new PgMailStore({ db, objects: bucket.objects, links });
});

afterAll(async () => {
  await database.teardown();
});

afterEach(async () => {
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
  await Promise.all(relays.map((l) => l.close()));
  relays = [];
});

/** A seeded mailbox whose IMAP goes through a relay the test can break. */
async function seedBehindLink() {
  const seeded = await seedMailbox(db);
  const link = await faultyLink(greenmail);
  relays.push(link);
  const box = { ...seeded.box, imap: { host: "127.0.0.1", port: link.port, secure: false } };
  return { ...seeded, box, link };
}

function connect(
  box: Awaited<ReturnType<typeof seedMailbox>>["box"],
  options: Partial<ConstructorParameters<typeof MailboxConnection>[1]> = {},
) {
  const connection = new MailboxConnection(box, {
    store,
    logger,
    reconnectBaseMs: 100,
    reconnectMaxMs: 500,
    ...options,
  });
  connections.push(connection);
  return connection;
}

const subjects = async (mailboxId: string) =>
  (await stored(db, mailboxId, "INBOX")).map((m) => m.subject).toSorted();

describe("mail service under faults", () => {
  it("reconnects after every connection drops and converges on what changed while it was down", async () => {
    const { box, link } = await seedBehindLink();
    await deliver(box.address, "kept");
    await deliver(box.address, "deleted while down");
    const connection = connect(box);
    await connection.start();
    expect(await subjects(box.id)).toEqual(["deleted while down", "kept"]);

    // The server goes away and refuses to come back for a while.
    link.refuse();
    link.sever();
    await waitFor(() => !connection.connected);
    const acceptedWhileDown = link.accepted;
    // Another client still reaches GreenMail directly.
    await otherClient(box, async (client) => {
      await client.mailboxOpen("INBOX");
      await client.messageDelete({ header: { subject: "deleted while down" } });
    });
    await deliver(box.address, "arrived while down");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    // It kept retrying, with backoff rather than a hot loop (base 100ms, cap 500ms: 3 to ~30).
    const retries = link.accepted - acceptedWhileDown;
    expect(retries).toBeGreaterThanOrEqual(3);
    expect(retries).toBeLessThan(30);

    link.restore();
    await waitFor(() => connection.isReady);
    await waitFor(async () => (await subjects(box.id)).length === 2);
    expect(await subjects(box.id)).toEqual(["arrived while down", "kept"]);

    // IDLE is armed again on the new connection.
    await deliver(box.address, "after reconnect");
    await waitFor(async () => (await subjects(box.id)).includes("after reconnect"), 5_000);
  });

  it("notices a connection that went silent without closing, and reconnects", async () => {
    const { box, link } = await seedBehindLink();
    const connection = connect(box, { socketTimeoutMs: 500 });
    await connection.start();

    // A NAT forgot the flow: no FIN, no RST, just nothing. Only a timeout can tell.
    link.goSilent();
    await deliver(box.address, "sent into the void");
    await waitFor(async () => (await subjects(box.id)).includes("sent into the void"), 8_000);
    // Delivered through a new connection: the silent one was detected and replaced.
    expect(link.accepted).toBeGreaterThan(1);
  });

  it("stores the rest of a folder when one message cannot be stored, and comes up ready", async () => {
    const { box } = await seedMailbox(db);
    // A real hostile header: a Message-ID too long for the Postgres unique index.
    const poison = [
      "From: hostile@outside.test",
      `To: ${box.address}`,
      "Subject: poison",
      `Message-ID: <${randomBytes(4_000).toString("hex")}@outside.test>`,
      "",
      "body",
      "",
    ].join("\r\n");
    await deliver(box.address, "older");
    await otherClient(box, (client) => client.append("INBOX", poison));
    await deliver(box.address, "newer");

    const connection = connect(box, { batchSize: 1 });
    await connection.start();
    expect(connection.isReady).toBe(true);
    expect(await subjects(box.id)).toEqual(["newer", "older"]);

    // Still retried on every sync, still not blocking anything.
    const [inbox] = (await connection.syncAll()).filter((r) => r.folder === "INBOX");
    expect(inbox).toMatchObject({ added: 0, failed: 1 });
    await deliver(box.address, "later");
    await waitFor(async () => (await subjects(box.id)).includes("later"), 5_000);
  });

  it("defers a send while the mailbox is offline, then sends it exactly once", async () => {
    const seeded = await seedBehindLink();
    const { box, link } = seeded;
    const actions = new PgActionSource({ db });
    const connection = connect(box);
    const executor = new OutboxExecutor({
      actions,
      logger,
      connection: (id) => (id === box.id ? connection : undefined),
      deferMs: 100,
    });
    await connection.start();
    link.refuse();
    link.sever();
    await waitFor(() => !connection.connected);

    const recipient = mailbox();
    const key = `offline-${box.id}`;
    const { id } = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: key,
      payload: { from: box.address, to: [recipient.address], subject: "offline send", text: "hi" },
    });
    // Two drains while offline: SMTP goes out once, the Sent copy waits, no attempt is spent.
    for (let i = 0; i < 2; i++) {
      await executor.drain();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const deferred = await actionRow(db, id);
    expect(deferred).toMatchObject({ status: "pending", attempts: 0 });
    expect(deferred.smtpAcceptedAt).not.toBeNull();

    link.restore();
    await waitFor(() => connection.isReady);
    await executor.drain();
    expect(await actionRow(db, id)).toMatchObject({ status: "done" });

    const messageId = deterministicMessageId(key, box.address);
    const copies = (folder: string, owner: typeof box) =>
      otherClient(owner, async (client) => {
        await client.mailboxOpen(folder);
        return (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
      });
    expect(await copies("INBOX", recipient)).toHaveLength(1);
    expect(await copies("Sent", box)).toHaveLength(1);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("the service process, stopped and killed mid-import", () => {
  const secret = randomBytes(32).toString("hex");
  const keyringSecret = `k1:${randomBytes(32).toString("base64")}`;
  let worker: Server;
  let workerUrl: string;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    // The Worker's events endpoint, accepting everything: this suite counts rows, not events.
    worker = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(202).end());
    });
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    child?.kill("SIGKILL");
    await new Promise((resolve) => worker.close(resolve));
  });

  async function startProcess() {
    const port = await freePort();
    const proc = spawn(process.execPath, ["src/main.ts"], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        LOG_LEVEL: "info",
        DATABASE_URL: database.url,
        MAIL_CREDENTIALS_KEY: keyringSecret,
        MAIL_SERVICE_HMAC_SECRET: secret,
        WORKER_URL: workerUrl,
        S3_ENDPOINT: bucket.options.endpoint,
        S3_BUCKET: bucket.options.bucket,
        S3_ACCESS_KEY_ID: bucket.options.accessKeyId,
        S3_SECRET_ACCESS_KEY: bucket.options.secretAccessKey,
        S3_REGION: bucket.options.region,
      },
    });
    child = proc;
    let output = "";
    proc.stdout?.on("data", (chunk) => (output += chunk));
    proc.stderr?.on("data", (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => proc.on("exit", resolve));
    return { proc, port, exited, output: () => output };
  }

  it("exits cleanly on SIGTERM mid-import, and converges after a SIGKILL", async () => {
    const seeded = await seedMailbox(db);
    const { box } = seeded;
    await setCredentials(
      db,
      box.id,
      await sealCredentials(parseKeyring(keyringSecret), box.id, {
        user: box.user,
        pass: box.pass,
        imap: box.imap,
        smtp: box.smtp,
      }),
    );
    const total = 600;
    await otherClient(box, async (client) => {
      for (let n = 0; n < total; n++) {
        await client.append(
          "INBOX",
          `From: a@outside.test\r\nTo: ${box.address}\r\nSubject: bulk ${n}\r\nMessage-ID: <bulk-${n}-${box.id}@outside.test>\r\n\r\nbody ${n}\r\n`,
        );
      }
    });
    const count = async () => (await stored(db, box.id, "INBOX")).length;

    // 1. SIGTERM mid-import: exits 0 well inside a host's kill timeout, logged out cleanly.
    const first = await startProcess();
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${first.port}/health`).catch(() => null);
      return response?.ok;
    });
    await waitFor(async () => (await count()) >= 20, 30_000);
    const health = await fetch(`http://127.0.0.1:${first.port}/health`);
    expect(await health.json()).toMatchObject({ ok: true, database: true, mailboxes: 1 });
    const sigtermAt = Date.now();
    first.proc.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    expect(Date.now() - sigtermAt).toBeLessThan(10_000);
    expect(first.output()).toContain('"event":"shutdown.done"');
    const afterTerm = await count();
    expect(afterTerm).toBeLessThan(total);

    // 2. SIGKILL mid-import: no chance to clean up at all.
    const second = await startProcess();
    await waitFor(async () => (await count()) >= afterTerm + 20, 30_000);
    second.proc.kill("SIGKILL");
    await second.exited;
    expect(await count()).toBeLessThan(total);

    // 3. A third start finishes the import: every message once, nothing duplicated.
    const third = await startProcess();
    await waitFor(async () => (await count()) === total, 60_000);
    third.proc.kill("SIGTERM");
    expect(await third.exited).toBe(0);
    const rows = await messageRows(db, box.id);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((r) => r.messageIdHeader)).size).toBe(total);
  }, 120_000);
});
