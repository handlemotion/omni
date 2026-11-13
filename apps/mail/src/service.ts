// Assembles the mail service: Postgres storage, one supervised connection per mailbox, HTTP.
// `main.ts` runs it as a process; e2e suites run it in-process against the real local stack.
import {
  createDb,
  listServiceMailboxes,
  markNotified,
  pendingNotifications,
  setMailboxStatus,
} from "@omni/db";
import { MAX_PRUNED_THREADS_PER_EVENT } from "@omni/contracts";
import { sql } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import type { Hono } from "hono";
import type { Config } from "./config.ts";
import { mailboxAuth, openCredentials } from "./credentials.ts";
import { createDnsLookup } from "./dns.ts";
import { createApp, hmacVerifier } from "./http.ts";
import type { Logger } from "./log.ts";
import { WorkerNotifier } from "./notify.ts";
import { createS3Store } from "./objects.ts";
import { PgActionSource, PgMailStore, PgSendFiles } from "./pg-store.ts";
import { connectGoogle, createGoogleOAuth, disconnectGoogle } from "./providers/gmail.ts";
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
      | "PURELYMAIL_API_TOKEN"
      | "DNS_RESOLVERS"
      | "DNS_NAMESERVER_PORT"
      | "DNS_TIMEOUT_MS"
      | "NOTIFY_SWEEP_MS"
      | "GOOGLE_CLIENT_ID"
      | "GOOGLE_CLIENT_SECRET"
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
  const google =
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
      ? createGoogleOAuth({
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
        })
      : undefined;
  const notifier = new WorkerNotifier({
    workerUrl: config.WORKER_URL,
    secret: config.MAIL_SERVICE_HMAC_SECRET,
    logger: log,
    onDelivered: async (events) => {
      const ids = events.flatMap((e) => (e.type === "message.created" ? [e.messageId] : []));
      // Left pending, the sweep sends them again (at least once). The Worker does not dedupe
      // yet, so a failed write here can repeat a push for that message; rare, and better than
      // a lost one.
      await markNotified(db, ids).catch((error: unknown) =>
        log.warn("notify.mark_failed", { events: ids.length, error }),
      );
    },
  });
  /** Re-sends `message.created` for rows the Worker never accepted (crash, Worker outage). */
  const sweepNotifications = async () => {
    const rows = await pendingNotifications(db, 500);
    if (rows.length > 0) log.info("notify.sweep", { pending: rows.length });
    for (const row of rows) notifier.push({ type: "message.created", ...row });
  };
  const objects = createS3Store({
    endpoint: config.S3_ENDPOINT,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    region: config.S3_REGION,
  });
  const store = new PgMailStore({
    db,
    onIngested: ({ folder: _folder, ...message }) =>
      notifier.push({ type: "message.created", ...message }),
    // Not swept like `message.created`: lost in a crash, the threads only keep a stale summary
    // until their next message.
    onPruned: ({ threadIds, ...pruned }) => {
      for (let i = 0; i < threadIds.length; i += MAX_PRUNED_THREADS_PER_EVENT) {
        const chunk = threadIds.slice(i, i + MAX_PRUNED_THREADS_PER_EVENT);
        notifier.push({ type: "messages.pruned", ...pruned, threadIds: chunk });
      }
    },
    // Not swept either: lost, open apps show the merged threads until their next refresh.
    onMerged: (merged) => notifier.push({ type: "threads.merged", ...merged }),
    // Not swept either: the next full sync finds the same conversations again.
    onDiscarded: ({ threadIds, ...discarded }) => {
      for (let i = 0; i < threadIds.length; i += MAX_PRUNED_THREADS_PER_EVENT) {
        const chunk = threadIds.slice(i, i + MAX_PRUNED_THREADS_PER_EVENT);
        notifier.push({ type: "threads.discarded", ...discarded, threadIds: chunk });
      }
    },
    objects,
    links: { imageProxyUrl: config.IMAGE_PROXY_URL, attachmentUrl: config.ATTACHMENT_URL },
  });
  const supervisor = new Supervisor({
    store,
    files: new PgSendFiles({ db, objects }),
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
      let auth;
      try {
        credentials = await openCredentials(
          config.MAIL_CREDENTIALS_KEY,
          row.id,
          row.credentialsEnc,
        );
        auth = mailboxAuth(credentials, google);
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
        user: credentials.user,
        auth,
        imap: credentials.imap,
        smtp: credentials.smtp,
      });
      const setStatus = (status: "active" | "error") =>
        setMailboxStatus(db, row.id, status).catch((error: unknown) =>
          log.warn("mailbox.status_failed", { mailboxId: row.id, error }),
        );
      connection.on("connected", () => void setStatus("active"));
      // Shows the app a mailbox whose app password or Google access was revoked; retrying
      // continues until the connection gives up.
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

  /** Connects a mailbox with its stored credentials, replacing a connection it already has. */
  const reconnect = async (mailboxId: string) => {
    if (supervisor.has(mailboxId)) await supervisor.remove(mailboxId);
    await reconcileMailboxes();
  };

  supervisor.start();
  await sweepNotifications().catch((error: unknown) => log.error("notify.sweep_failed", { error }));
  const sweepLoop = every(config.NOTIFY_SWEEP_MS ?? 60_000, () =>
    sweepNotifications().catch((error: unknown) => log.error("notify.sweep_failed", { error })),
  );
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
    connect: reconnect,
    logger: log,
  });

  const httpLog = log.child({ component: "http" });
  const app = createApp({
    provisioner,
    ...(google
      ? {
          connectGoogle: (input) =>
            connectGoogle(
              {
                db,
                keyring: config.MAIL_CREDENTIALS_KEY,
                oauth: google,
                connect: reconnect,
                logger: log,
              },
              input,
            ),
        }
      : {}),
    // Works without the OAuth client too: revoking needs none, and a self-hoster who removed it
    // can still let people disconnect.
    disconnectGoogle: (input) =>
      disconnectGoogle(
        {
          db,
          keyring: config.MAIL_CREDENTIALS_KEY,
          stop: (mailboxId) => supervisor.retire(mailboxId),
          logger: log,
        },
        input,
      ),
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
      await Effect.runPromise(Fiber.interrupt(sweepLoop));
      await reconciling?.catch(() => {});
      await supervisor.stop();
      await notifier.stop();
      await close();
    },
  };
}
