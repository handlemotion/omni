// Assembles the mail service: Postgres storage, one supervised connection per mailbox, HTTP.
// `main.ts` runs it as a process; e2e suites run it in-process against the real local stack.
import { createDb, listServiceMailboxes, setMailboxStatus } from "@omni/db";
import { sql } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import type { Hono } from "hono";
import type { Config } from "./config.ts";
import { openCredentials } from "./credentials.ts";
import { createDnsLookup } from "./dns.ts";
import { createApp, hmacVerifier } from "./http.ts";
import type { Logger } from "./log.ts";
import { WorkerNotifier } from "./notify.ts";
import { createS3Store } from "./objects.ts";
import { PgActionSource, PgMailStore } from "./pg-store.ts";
import { createPurelymailClient } from "./providers/purelymail.ts";
import { createProvisioner } from "./provisioning.ts";
import { Supervisor } from "./supervisor.ts";
import { every } from "./timing.ts";

export type ServiceConfig = Pick<
  Config,
  | "DATABASE_URL"
  | "MAIL_CREDENTIALS_KEY"
  | "SYNC_INTERVAL_MS"
  | "OUTBOX_INTERVAL_MS"
  | "MAILBOX_CONCURRENCY"
  | "MAIL_SERVICE_HMAC_SECRET"
  | "WORKER_URL"
  | "S3_ENDPOINT"
  | "S3_BUCKET"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "S3_REGION"
  | "IMAGE_PROXY_URL"
  | "ATTACHMENT_URL"
> &
  Partial<
    Pick<
      Config,
      "PURELYMAIL_API_TOKEN" | "DNS_RESOLVERS" | "DNS_NAMESERVER_PORT" | "DNS_TIMEOUT_MS"
    >
  >;

export interface MailService {
  app: Hono;
  supervisor: Supervisor;
  /** Connects mailboxes added since the last call and drops disabled or deleted ones. */
  reconcileMailboxes(): Promise<void>;
  stop(): Promise<void>;
}

export async function startService(config: ServiceConfig, log: Logger): Promise<MailService> {
  const { db, close } = createDb(config.DATABASE_URL);
  const notifier = new WorkerNotifier({
    workerUrl: config.WORKER_URL,
    secret: config.MAIL_SERVICE_HMAC_SECRET,
    logger: log,
  });
  const store = new PgMailStore({
    db,
    onIngested: ({ folder: _folder, ...message }) =>
      notifier.push({ type: "message.created", ...message }),
    objects: createS3Store({
      endpoint: config.S3_ENDPOINT,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      region: config.S3_REGION,
    }),
    links: { imageProxyUrl: config.IMAGE_PROXY_URL, attachmentUrl: config.ATTACHMENT_URL },
  });
  const supervisor = new Supervisor({
    store,
    actions: new PgActionSource({
      db,
      onFailed: (action) => notifier.push({ type: "action.failed", ...action }),
    }),
    logger: log,
    syncIntervalMs: config.SYNC_INTERVAL_MS,
    outboxIntervalMs: config.OUTBOX_INTERVAL_MS,
    concurrency: config.MAILBOX_CONCURRENCY,
  });

  // One reconcile at a time; a request during one runs once more after it.
  let reconciling: Promise<void> | null = null;
  let again = false;
  let stopping = false;
  async function reconcileOnce() {
    if (stopping) return;
    const rows = await listServiceMailboxes(db);
    const wanted = new Set(rows.map((row) => row.id));
    for (const id of supervisor.mailboxIds()) {
      if (!wanted.has(id)) await supervisor.remove(id);
    }
    for (const row of rows) {
      if (stopping) return;
      if (supervisor.has(row.id)) continue;
      let credentials;
      try {
        credentials = await openCredentials(
          config.MAIL_CREDENTIALS_KEY,
          row.id,
          row.credentialsEnc,
        );
      } catch (error) {
        log.error("mailbox.credentials_unreadable", { mailboxId: row.id, error });
        await setMailboxStatus(db, row.id, "error");
        continue;
      }
      const connection = supervisor.add({
        id: row.id,
        orgId: row.orgId,
        address: row.address,
        kind: row.kind,
        ...credentials,
      });
      const setStatus = (status: "active" | "error") =>
        setMailboxStatus(db, row.id, status).catch((error: unknown) =>
          log.warn("mailbox.status_failed", { mailboxId: row.id, error }),
        );
      connection.on("connected", () => void setStatus("active"));
      // Shows the app a mailbox whose app password was revoked; retrying continues.
      connection.on("auth_failed", () => void setStatus("error"));
    }
  }
  function reconcileMailboxes(): Promise<void> {
    if (reconciling) {
      again = true;
      return reconciling;
    }
    reconciling = (async () => {
      do {
        again = false;
        await reconcileOnce();
      } while (again);
    })().finally(() => {
      reconciling = null;
    });
    return reconciling;
  }

  supervisor.start();
  await reconcileMailboxes();
  const reconcileLoop = every(config.SYNC_INTERVAL_MS, () =>
    reconcileMailboxes().catch((error: unknown) =>
      log.error("mailbox.reconcile_failed", { error }),
    ),
  );

  const provisioner = createProvisioner({
    db,
    keyring: config.MAIL_CREDENTIALS_KEY,
    purelymail: config.PURELYMAIL_API_TOKEN
      ? createPurelymailClient(config.PURELYMAIL_API_TOKEN)
      : undefined,
    connect: async (mailboxId) => {
      if (supervisor.has(mailboxId)) await supervisor.remove(mailboxId);
      await reconcileMailboxes();
    },
    logger: log,
  });

  const httpLog = log.child({ component: "http" });
  const app = createApp({
    provisioner,
    log: httpLog,
    dns: createDnsLookup({
      resolvers: config.DNS_RESOLVERS ?? [],
      nameserverPort: config.DNS_NAMESERVER_PORT ?? 53,
      timeoutMs: config.DNS_TIMEOUT_MS ?? 2_000,
      logger: log,
    }),
    onError: (error) => httpLog.error("http.error", { error }),
    verify: hmacVerifier(config.MAIL_SERVICE_HMAC_SECRET, {
      onReject: (reason) => httpLog.warn("http.ping_rejected", { reason }),
    }),
    onPing: ({ requestId }) => {
      httpLog.info("outbox.pinged", { requestId });
      // A ping means the Worker changed something: new actions, or a mailbox added.
      void reconcileMailboxes()
        .catch((error: unknown) => log.error("mailbox.reconcile_failed", { error }))
        .then(() => supervisor.ping());
    },
    // Ready means this process can do its job: not shutting down, and Postgres answers. IMAP is
    // reported but does not fail the check: a mail host outage must not fail deploys or make the
    // host cycle a machine that would only reconnect to the same outage.
    health: async () => {
      const database = stopping ? false : await databaseAnswers();
      return {
        ok: !stopping && database,
        stopping,
        database,
        mailboxes: supervisor.mailboxCount,
        connected: supervisor.connectedCount,
        ready: supervisor.readyCount,
      };
    },
  });

  async function databaseAnswers(): Promise<boolean> {
    let deadline: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        db.execute(sql`select 1`).then(() => true),
        new Promise<boolean>((resolve) => (deadline = setTimeout(() => resolve(false), 2_000))),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    app,
    supervisor,
    reconcileMailboxes,
    stop: async () => {
      stopping = true;
      await Effect.runPromise(Fiber.interrupt(reconcileLoop));
      await reconciling?.catch(() => {});
      await supervisor.stop();
      await notifier.stop();
      await close();
    },
  };
}
